import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type pg from 'pg'

import { loadEvalSuite, type EvalCase } from '../evals/index.js'
import { previewNightlyPlan, readPlanPreviewConfig, type PlanPreviewResult } from '../orchestrator/planPreview.js'

/**
 * The server-importable planning entrypoint (`@agentforge/worker/planning`).
 * It runs the Orchestrator's DRY-RUN planner against Postgres and upserts the
 * ONE standing scheduled cron plan row — the same core as `plan:preview` and
 * the nightly cron's post-run re-plan — so the dashboard's "Plan now" can call
 * it directly, whatever state the worker is in. No target or model call, no
 * spend, and operator_requests are not drained.
 */

export type { PlanPreviewResult } from '../orchestrator/planPreview.js'

export interface PlanNextNightlyOptions {
  pool: Pick<pg.Pool, 'query' | 'connect'>
  /** NIGHTLY_BUDGET_USD (fallback when platform_settings has no budget), PLAN_*, NIGHTLY_HOUR/TZ, AGENTFORGE_SEED_DIR. */
  env?: NodeJS.ProcessEnv
  now?: Date
  /** Defaults to the next window after `now` (01:00 America/Chicago). */
  scheduledFor?: Date
  /** Defaults to PLAN_TARGET_VERSION, else the most recently recorded target version. */
  targetVersion?: string
}

/** evals/seeds: AGENTFORGE_SEED_DIR, else relative to this module (dist/planning -> repo root). */
export function resolveSeedDir(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = (env.AGENTFORGE_SEED_DIR ?? '').trim()
  if (explicit) return explicit
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'evals', 'seeds')
}

export function loadPlanningSeeds(env: NodeJS.ProcessEnv = process.env): EvalCase[] {
  return loadEvalSuite(resolveSeedDir(env))
}

/** Plans the next nightly and upserts the standing scheduled row; returns that row and its NightlyPlan v1. */
export async function planNextNightly(options: PlanNextNightlyOptions): Promise<PlanPreviewResult> {
  const env = options.env ?? process.env
  const config = readPlanPreviewConfig(env)
  return previewNightlyPlan({
    pool: options.pool,
    seeds: loadPlanningSeeds(env),
    config: { ...config, ...(options.targetVersion ? { targetVersion: options.targetVersion } : {}) },
    now: options.now ?? new Date(),
    ...(options.scheduledFor ? { scheduledFor: options.scheduledFor } : {}),
  })
}
