import type { PlanPreviewResult } from './planPreview.js'
import type { RunPlanResult } from './run.js'
import { DEFAULT_NIGHTLY_TIME_ZONE } from './schedule.js'

/**
 * The nightly cron (ARCHITECTURE 7.0: pg-boss, default 01:00 CT). Each firing
 * polls the target version (a version change owes the full regression suite,
 * 7.4), executes the standing plan, then plans the next window
 * ({@link runNightlyJob}). The schedule is registered only
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
  /** The standing scheduled cron plan (the row the dashboard shows), if any. */
  findStandingPlan(): Promise<{ nightlyRunId: number; targetVersion: string | null } | null>
  /**
   * plan:preview (upserts the ONE standing scheduled row). `scheduledFor` set =
   * this firing's window; undefined = the NEXT window. `targetVersion`
   * undefined = the latest recorded.
   */
  preview(args: { targetVersion?: string; scheduledFor?: Date }): Promise<PlanPreviewResult>
  /** The scheduled-run consumer, claiming exactly that row. */
  execute(claimId: number): Promise<RunPlanResult | null>
  log?(message: string): void
}

export interface NightlyJobResult {
  /** The row that was executed tonight. */
  executedRowId: number
  result: RunPlanResult | null
  /** Tomorrow's standing plan, generated right after the run. */
  nextPlan: PlanPreviewResult | null
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

/**
 * Plan-after-execute: run tonight's standing plan (the one the dashboard showed
 * all day), then immediately plan the NEXT window — whether the run succeeded
 * or failed — so a fresh standing plan is visible for the coming day. With no
 * standing plan (first run after enabling), or one made for a target version
 * that has since changed (its regressions are stale and its attempts would be
 * mislabeled), tonight is planned first.
 */
export async function runNightlyJob(deps: NightlyJobDeps): Promise<NightlyJobResult> {
  const log = deps.log ?? (() => {})
  // This firing's window: the fire time to the minute, so a tick-time plan is for tonight, not tomorrow.
  const tonight = new Date(Math.floor(deps.now().getTime() / 60_000) * 60_000)

  let targetVersion: string | undefined
  try {
    targetVersion = await deps.pollTargetVersion()
    await deps.recordTargetVersion(targetVersion)
  } catch (error) {
    log(`Target version poll failed (${message(error)}); trusting the standing plan / latest recorded version.`)
  }
  const versionArg = targetVersion ? { targetVersion } : {}

  const standing = await deps.findStandingPlan()
  const stale = standing !== null && targetVersion !== undefined && standing.targetVersion !== targetVersion
  let executedRowId: number
  if (standing === null || stale) {
    log(
      standing === null
        ? 'No standing plan; planning tonight first.'
        : `Standing plan is for ${standing.targetVersion}, target is now ${targetVersion}; re-planning tonight.`,
    )
    const planned = await deps.preview({ ...versionArg, scheduledFor: tonight })
    executedRowId = planned.nightlyRunId
  } else {
    executedRowId = standing.nightlyRunId
  }

  let result: RunPlanResult | null = null
  let runError: unknown
  try {
    result = await deps.execute(executedRowId)
    log(result === null ? `Row ${executedRowId} was already claimed; nothing executed.` : `Run ${result.nightlyRunId}: ${result.status}, spend $${result.spendUsd.toFixed(3)}.`)
  } catch (error) {
    runError = error
    log(`Run of row ${executedRowId} failed: ${message(error)}`)
  }

  // Always leave a standing plan for the next window, even after a failed run.
  let nextPlan: PlanPreviewResult | null = null
  try {
    nextPlan = await deps.preview(versionArg)
    log(`Next plan for ${nextPlan.scheduledFor}: ${nextPlan.plan.run_count} run / ${nextPlan.plan.cut_count} cut (row ${nextPlan.nightlyRunId}).`)
  } catch (error) {
    if (runError === undefined) throw error
    log(`Re-plan after the failed run also failed: ${message(error)}`)
  }
  if (runError !== undefined) throw runError
  return { executedRowId, result, nextPlan }
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
