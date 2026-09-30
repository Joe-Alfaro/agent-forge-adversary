import { describe, expect, it } from 'vitest'

import {
  NIGHTLY_QUEUE,
  readNightlyCronConfig,
  registerNightlyCron,
  runNightlyJob,
  type CronBoss,
  type NightlyJobDeps,
} from '../nightlyJob.js'

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
    async preview({ targetVersion, scheduledFor }) {
      calls.push(`preview:${targetVersion}:${scheduledFor.toISOString()}`)
      return { nightlyRunId: 5, created: false, scheduledFor: scheduledFor.toISOString(), plan: {} as never }
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

describe('runNightlyJob', () => {
  it('polls the target version, previews tonight’s plan for this window, then executes that row', async () => {
    const calls: string[] = []
    await runNightlyJob(fakeDeps(calls))
    expect(calls).toEqual([
      'poll',
      'record:copilot@new',
      'preview:copilot@new:2026-09-30T06:00:00.000Z',
      'execute:5',
    ])
  })

  it('does not execute when the preview fails', async () => {
    const calls: string[] = []
    const deps = fakeDeps(calls, {
      async preview() {
        throw new Error('db down')
      },
    })
    await expect(runNightlyJob(deps)).rejects.toThrow('db down')
    expect(calls.some((c) => c.startsWith('execute'))).toBe(false)
  })

  it('falls back to the recorded version when the target version endpoint is unreachable', async () => {
    const calls: string[] = []
    const deps = fakeDeps(calls, {
      async pollTargetVersion() {
        throw new Error('ECONNREFUSED')
      },
      async preview({ targetVersion, scheduledFor }) {
        calls.push(`preview:${targetVersion ?? '(latest recorded)'}`)
        return { nightlyRunId: 6, created: true, scheduledFor: scheduledFor.toISOString(), plan: {} as never }
      },
    })
    await runNightlyJob(deps)
    expect(calls).toEqual(['preview:(latest recorded)', 'execute:6'])
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
