import { describe, expect, it } from 'vitest'

import {
  NIGHTLY_QUEUE,
  readNightlyCronConfig,
  registerNightlyCron,
  runNightlyJob,
  type CronBoss,
  type NightlyJobDeps,
} from '../nightlyJob.js'

/** Standing plan row 5 for copilot@new; previews write row 6 (tonight) or 7 (next window). */
function fakeDeps(calls: string[], over: Partial<NightlyJobDeps> = {}): NightlyJobDeps {
  return {
    now: () => new Date('2026-09-30T06:00:07.500Z'),
    async pollTargetVersion() {
      calls.push('poll')
      return 'copilot@new'
    },
    async recordTargetVersion(version) {
      calls.push(`record:${version}`)
    },
    async findStandingPlan() {
      calls.push('standing?')
      return { nightlyRunId: 5, targetVersion: 'copilot@new' }
    },
    async preview({ targetVersion, scheduledFor }) {
      calls.push(`preview:${targetVersion ?? '(latest)'}:${scheduledFor ? scheduledFor.toISOString() : 'next'}`)
      const id = scheduledFor ? 6 : 7
      return { nightlyRunId: id, created: true, scheduledFor: (scheduledFor ?? new Date('2026-10-01T06:00:00Z')).toISOString(), plan: { run_count: 1, cut_count: 0 } as never }
    },
    async execute(claimId) {
      calls.push(`execute:${claimId}`)
      return null
    },
    ...over,
  }
}

class FakeBoss implements CronBoss {
  calls: unknown[][] = []
  handler: (() => Promise<unknown>) | undefined
  async createQueue(name: string) {
    this.calls.push(['createQueue', name])
  }
  async schedule(name: string, cron: string, data: object | null, options: object) {
    this.calls.push(['schedule', name, cron, data, options])
  }
  async unschedule(name: string) {
    this.calls.push(['unschedule', name])
  }
  async work(name: string, options: object, handler: () => Promise<unknown>) {
    this.calls.push(['work', name, options])
    this.handler = handler
    return 'worker-1'
  }
}

describe('readNightlyCronConfig', () => {
  it('defaults to 01:00 America/Chicago and DISABLED', () => {
    expect(readNightlyCronConfig({})).toEqual({ enabled: false, cron: '0 1 * * *', timeZone: 'America/Chicago' })
  })

  it('reads NIGHTLY_CRON, NIGHTLY_TZ and requires NIGHTLY_ENABLED=true exactly', () => {
    expect(readNightlyCronConfig({ NIGHTLY_CRON: '30 2 * * *', NIGHTLY_TZ: 'UTC', NIGHTLY_ENABLED: 'true' })).toEqual({
      enabled: true,
      cron: '30 2 * * *',
      timeZone: 'UTC',
    })
    expect(readNightlyCronConfig({ NIGHTLY_ENABLED: 'yes' }).enabled).toBe(false)
  })

  it('rejects a cron expression that is not five fields', () => {
    expect(() => readNightlyCronConfig({ NIGHTLY_CRON: 'nightly' })).toThrow(/NIGHTLY_CRON/)
  })
})

describe('runNightlyJob (plan-after-execute)', () => {
  it('executes the standing plan, then plans the NEXT window so a plan is visible all day', async () => {
    const calls: string[] = []
    const done = await runNightlyJob(fakeDeps(calls))
    expect(calls).toEqual(['poll', 'record:copilot@new', 'standing?', 'execute:5', 'preview:copilot@new:next'])
    expect(done.executedRowId).toBe(5)
    expect(done.nextPlan?.nightlyRunId).toBe(7)
  })

  it('with no standing plan (first run after enable): plans this window, runs it, then plans the next', async () => {
    const calls: string[] = []
    await runNightlyJob(fakeDeps(calls, { findStandingPlan: async () => (calls.push('standing?'), null) }))
    expect(calls).toEqual([
      'poll',
      'record:copilot@new',
      'standing?',
      'preview:copilot@new:2026-09-30T06:00:00.000Z',
      'execute:6',
      'preview:copilot@new:next',
    ])
  })

  it('re-plans this window when the target version changed since the standing plan was made', async () => {
    const calls: string[] = []
    await runNightlyJob(
      fakeDeps(calls, { findStandingPlan: async () => (calls.push('standing?'), { nightlyRunId: 5, targetVersion: 'copilot@old' }) }),
    )
    // The refresh upserts the same standing row (the preview's single-row rule), then runs and re-plans.
    expect(calls).toEqual([
      'poll',
      'record:copilot@new',
      'standing?',
      'preview:copilot@new:2026-09-30T06:00:00.000Z',
      'execute:6',
      'preview:copilot@new:next',
    ])
  })

  it('a run that FAILS still re-plans the next window, then surfaces the failure', async () => {
    const calls: string[] = []
    const deps = fakeDeps(calls, {
      async execute(claimId) {
        calls.push(`execute:${claimId}`)
        throw new Error('credit balance is too low')
      },
    })
    await expect(runNightlyJob(deps)).rejects.toThrow('credit balance is too low')
    expect(calls.at(-1)).toBe('preview:copilot@new:next')
  })

  it('a failing re-plan does not mask a failed run (the run error wins)', async () => {
    const calls: string[] = []
    const logs: string[] = []
    const deps = fakeDeps(calls, {
      async execute() {
        throw new Error('run failed')
      },
      async preview({ scheduledFor }) {
        if (!scheduledFor) throw new Error('db down')
        return { nightlyRunId: 6, created: true, scheduledFor: scheduledFor.toISOString(), plan: {} as never }
      },
      log: (m) => logs.push(m),
    })
    await expect(runNightlyJob(deps)).rejects.toThrow('run failed')
    expect(logs.some((m) => m.includes('db down'))).toBe(true)
  })

  it('a failing re-plan after a successful run is surfaced', async () => {
    const calls: string[] = []
    const deps = fakeDeps(calls, {
      async preview() {
        throw new Error('db down')
      },
    })
    await expect(runNightlyJob(deps)).rejects.toThrow('db down')
  })

  it('falls back to the recorded version when the target version endpoint is unreachable', async () => {
    const calls: string[] = []
    const deps = fakeDeps(calls, {
      async pollTargetVersion() {
        throw new Error('ECONNREFUSED')
      },
    })
    await runNightlyJob(deps)
    // Unknown live version: the standing plan is trusted as-is.
    expect(calls).toEqual(['standing?', 'execute:5', 'preview:(latest):next'])
  })
})

describe('registerNightlyCron', () => {
  it('schedules the queue on the cron in the configured zone, with no retries, and works it one job at a time', async () => {
    const boss = new FakeBoss()
    let ran = 0
    const state = await registerNightlyCron(boss, { enabled: true, cron: '0 1 * * *', timeZone: 'America/Chicago' }, async () => {
      ran += 1
    })
    expect(state).toBe('scheduled')
    expect(boss.calls[0]).toEqual(['createQueue', NIGHTLY_QUEUE])
    expect(boss.calls[1]).toEqual([
      'schedule',
      NIGHTLY_QUEUE,
      '0 1 * * *',
      null,
      expect.objectContaining({ tz: 'America/Chicago', retryLimit: 0, missed: 'skip' }),
    ])
    expect(boss.calls[2]?.[0]).toBe('work')
    await boss.handler?.()
    expect(ran).toBe(1)
  })

  it('when disabled, removes any existing schedule and registers no worker', async () => {
    const boss = new FakeBoss()
    const state = await registerNightlyCron(boss, { enabled: false, cron: '0 1 * * *', timeZone: 'America/Chicago' }, async () => {})
    expect(state).toBe('disabled')
    expect(boss.calls).toEqual([
      ['createQueue', NIGHTLY_QUEUE],
      ['unschedule', NIGHTLY_QUEUE],
    ])
  })
})
