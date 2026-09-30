import type { PlanPreviewResult } from './planPreview.js'
import type { RunPlanResult } from './run.js'
import { DEFAULT_NIGHTLY_TIME_ZONE } from './schedule.js'

/**
 * The nightly cron (ARCHITECTURE 7.0: pg-boss, default 01:00 CT). Each firing
 * polls the target version (a version change owes the full regression suite,
 * 7.4), refreshes tonight's plan with plan:preview for THIS window, then hands
 * that exact row to the scheduled-run consumer. The schedule is registered only
 * when NIGHTLY_ENABLED=true, so deploying the worker never starts spending by
 * accident; while disabled any previously registered schedule is removed.
 */

export const NIGHTLY_QUEUE = 'agentforge-nightly'
export const DEFAULT_NIGHTLY_CRON = '0 1 * * *'
/** The nightly window cap (ARCHITECTURE: 01:00 CT, three-hour cap); a longer job is expired. */
const NIGHTLY_JOB_EXPIRE_SECONDS = 3 * 60 * 60

export interface NightlyCronConfig {
  enabled: boolean
  cron: string
  timeZone: string
}

export function readNightlyCronConfig(env: NodeJS.ProcessEnv = process.env): NightlyCronConfig {
  const cron = (env.NIGHTLY_CRON ?? '').trim() || DEFAULT_NIGHTLY_CRON
  if (cron.split(/\s+/).length !== 5) {
    throw new Error(`NIGHTLY_CRON must be a five-field cron expression, got "${cron}"`)
  }
  return {
    enabled: env.NIGHTLY_ENABLED === 'true',
    cron,
    timeZone: (env.NIGHTLY_TZ ?? '').trim() || DEFAULT_NIGHTLY_TIME_ZONE,
  }
}

export interface NightlyJobDeps {
  now(): Date
  /** The target's live version (a read, no spend). */
  pollTargetVersion(): Promise<string>
  /** Records the version so the planner sees a change (target_versions). */
  recordTargetVersion(version: string): Promise<void>
  /** plan:preview for this window; `targetVersion` undefined means the latest recorded. */
  preview(args: { targetVersion?: string; scheduledFor: Date }): Promise<PlanPreviewResult>
  /** The scheduled-run consumer, claiming exactly the previewed row. */
  execute(claimId: number): Promise<RunPlanResult | null>
  log?(message: string): void
}

export interface NightlyJobResult {
  preview: PlanPreviewResult
  result: RunPlanResult | null
}

export async function runNightlyJob(deps: NightlyJobDeps): Promise<NightlyJobResult> {
  const log = deps.log ?? (() => {})
  // This firing's window: the fire time to the minute, so the row is for tonight, not tomorrow.
  const scheduledFor = new Date(Math.floor(deps.now().getTime() / 60_000) * 60_000)

  let targetVersion: string | undefined
  try {
    targetVersion = await deps.pollTargetVersion()
    await deps.recordTargetVersion(targetVersion)
  } catch (error) {
    log(`Target version poll failed (${error instanceof Error ? error.message : 'unknown'}); planning against the latest recorded version.`)
  }

  const preview = await deps.preview({ ...(targetVersion ? { targetVersion } : {}), scheduledFor })
  log(`Plan for ${preview.scheduledFor}: ${preview.plan.run_count} run / ${preview.plan.cut_count} cut (row ${preview.nightlyRunId}).`)
  const result = await deps.execute(preview.nightlyRunId)
  log(result === null ? `Row ${preview.nightlyRunId} was already claimed; nothing executed.` : `Run ${result.nightlyRunId}: ${result.status}, spend $${result.spendUsd.toFixed(3)}.`)
  return { preview, result }
}

/** The pg-boss surface the cron needs (structural, so it can be faked in tests). */
export interface CronBoss {
  createQueue(name: string): Promise<void>
  schedule(name: string, cron: string, data: object | null, options: object): Promise<void>
  unschedule(name: string): Promise<void>
  work(name: string, options: object, handler: () => Promise<unknown>): Promise<string>
}

export async function registerNightlyCron(
  boss: CronBoss,
  config: NightlyCronConfig,
  handler: () => Promise<unknown>,
): Promise<'scheduled' | 'disabled'> {
  await boss.createQueue(NIGHTLY_QUEUE)
  if (!config.enabled) {
    await boss.unschedule(NIGHTLY_QUEUE)
    return 'disabled'
  }
  // No retries: a failed nightly must not silently spend a second envelope.
  // Missed firings (worker down at 01:00) are skipped, not replayed at startup.
  await boss.schedule(NIGHTLY_QUEUE, config.cron, null, {
    tz: config.timeZone,
    retryLimit: 0,
    missed: 'skip',
    expireInSeconds: NIGHTLY_JOB_EXPIRE_SECONDS,
  })
  await boss.work(NIGHTLY_QUEUE, { batchSize: 1 }, async () => handler())
  return 'scheduled'
}
