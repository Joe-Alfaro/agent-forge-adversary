import type pg from 'pg'

import { previewNightlyPlan, readPlanPreviewConfig, type PlanPreviewResult } from './planPreview.js'
import { SEED_INDEX } from './seedIndex.js'

export * from './budget.js'
export * from './owasp.js'
export * from './pgPlanningRepository.js'
export * from './planner.js'
export * from './planPreview.js'
export * from './priority.js'
export * from './schedule.js'
export * from './seeds.js'
export { SEED_INDEX } from './seedIndex.js'

export interface PlanTonightNowOptions {
  pool: Pick<pg.Pool, 'query' | 'connect'>
  /** Defaults to the current time; the plan is for the next window after it. */
  now?: Date
  /** NIGHTLY_BUDGET_USD (fallback when platform_settings has none), PLAN_*, NIGHTLY_HOUR / NIGHTLY_TZ. Default process.env. */
  env?: NodeJS.ProcessEnv
  /** Plan this window instead of the next one (the nightly cron's tick-time plan). */
  scheduledFor?: Date
  /** Plan for this target version instead of PLAN_TARGET_VERSION / the latest recorded. */
  targetVersion?: string
}

/**
 * The Orchestrator's one planner (ARCHITECTURE 7.0, 7.2), shared by the
 * dashboard's "Plan now", the plan:preview CLI, and the nightly cron's re-plan.
 * DRY RUN: it reads tonight's inputs from Postgres (queued operator_requests,
 * owed regressions, coverage matrix, operator budget), builds NightlyPlan v1,
 * and upserts the ONE standing scheduled cron row (advisory-locked). No target
 * or model call, no spend, and operator_requests are not drained. The seed
 * suite's ids and OWASP mapping are embedded (SEED_INDEX), so it needs no
 * evals/ directory on disk.
 */
export async function planTonightNow(options: PlanTonightNowOptions): Promise<PlanPreviewResult> {
  const env = options.env ?? process.env
  const config = readPlanPreviewConfig(env)
  return previewNightlyPlan({
    pool: options.pool,
    seeds: [...SEED_INDEX],
    config: { ...config, ...(options.targetVersion ? { targetVersion: options.targetVersion } : {}) },
    now: options.now ?? new Date(),
    ...(options.scheduledFor ? { scheduledFor: options.scheduledFor } : {}),
  })
}
