import { randomUUID } from 'node:crypto'

import type pg from 'pg'

import { isAttackCategory, type NightlyPlan, type PriorityTerms } from '@agentforge/contracts'

import { DEFAULT_NIGHTLY_BUDGET_USD } from './budget.js'
import { buildCellOwaspMap, unmappedCells } from './owasp.js'
import type { PlanningSeed } from './seeds.js'
import { PgPlanningRepository } from './pgPlanningRepository.js'
import { buildNightlyPlan, REGRESSION_REPLAYS } from './planner.js'
import { DEFAULT_WEIGHTS } from './priority.js'
import { DEFAULT_NIGHTLY_HOUR, DEFAULT_NIGHTLY_TIME_ZONE, nextNightlyWindow, type NightlyWindowConfig } from './schedule.js'

/**
 * The DRY-RUN nightly plan preview (ARCHITECTURE 7.0, 7.2). It runs the
 * Orchestrator planner over tonight's real inputs — the queued operator
 * requests, the regressions owed to a changed target or to tickets moved to
 * `fixed`, and the coverage matrix scored by the priority formula — and writes
 * the resulting NightlyPlan v1 to ONE `nightly_runs` row (`trigger = 'cron'`,
 * `status = 'scheduled'`, `scheduled_for` = the next window). Nothing executes
 * and nothing is spent: no target call, no model call, no operator_requests
 * status change. Re-running refreshes that row's plan in place, so the
 * dashboard's Tonight's queue always reads the Orchestrator's current plan.
 */

export interface PlanPreviewConfig {
  /** The envelope when platform_settings has no operator value (NIGHTLY_BUDGET_USD, else $25). */
  budgetUsd: number
  weights: PriorityTerms
  costPerAttemptUsd: number
  maxAttemptsPerCampaign: number
  topK: number
  window: NightlyWindowConfig
  /** Plan for this target version; defaults to the most recently seen one. */
  targetVersion?: string
  /** Restrict coverage campaigns to these taxonomy categories (PLAN_CATEGORIES); all when absent. */
  categories?: string[]
}

/** Keeps the cells in `categories`; every cell when unscoped. */
export function scopeCellsToCategories<T extends { category: string }>(cells: T[], categories: string[] | undefined): T[] {
  return categories === undefined ? cells : cells.filter((c) => categories.includes(c.category))
}

export const DEFAULT_COST_PER_ATTEMPT_USD = 0.05
export const DEFAULT_PREVIEW_MAX_ATTEMPTS = 4
export const DEFAULT_PREVIEW_TOP_K = 6
/** Serializes concurrent previews so they refresh one row rather than racing two inserts. */
const PREVIEW_LOCK_KEY = 'agentforge:nightly_plan_preview'

function readNumber(env: NodeJS.ProcessEnv, name: string, fallback: number, integer = false): number {
  const raw = env[name]
  if (raw === undefined || raw.trim() === '') return fallback
  const value = Number(raw)
  if (!Number.isFinite(value) || value < 0 || (integer && !Number.isInteger(value))) {
    throw new Error(`${name} must be a non-negative ${integer ? 'integer' : 'number'}, got "${raw}"`)
  }
  return value
}

/**
 * Env knobs: NIGHTLY_BUDGET_USD (the envelope, default 25, same as the
 * dashboard), NIGHTLY_HOUR / NIGHTLY_TZ (window, default 01:00 America/Chicago),
 * PLAN_TOP_K, PLAN_MAX_ATTEMPTS, PLAN_COST_PER_ATTEMPT_USD, PLAN_TARGET_VERSION.
 */
export function readPlanPreviewConfig(env: NodeJS.ProcessEnv = process.env): PlanPreviewConfig {
  const targetVersion = (env.PLAN_TARGET_VERSION ?? '').trim()
  const categories = (env.PLAN_CATEGORIES ?? '')
    .split(',')
    .map((c) => c.trim())
    .filter((c) => c.length > 0)
  const unknown = categories.filter((c) => !isAttackCategory(c))
  if (unknown.length > 0) {
    throw new Error(`PLAN_CATEGORIES has unknown taxonomy categories: ${unknown.join(', ')}`)
  }
  return {
    budgetUsd: readNumber(env, 'NIGHTLY_BUDGET_USD', DEFAULT_NIGHTLY_BUDGET_USD),
    weights: DEFAULT_WEIGHTS,
    costPerAttemptUsd: readNumber(env, 'PLAN_COST_PER_ATTEMPT_USD', DEFAULT_COST_PER_ATTEMPT_USD),
    maxAttemptsPerCampaign: readNumber(env, 'PLAN_MAX_ATTEMPTS', DEFAULT_PREVIEW_MAX_ATTEMPTS, true),
    topK: readNumber(env, 'PLAN_TOP_K', DEFAULT_PREVIEW_TOP_K, true),
    window: {
      hour: readNumber(env, 'NIGHTLY_HOUR', DEFAULT_NIGHTLY_HOUR, true),
      timeZone: (env.NIGHTLY_TZ ?? '').trim() || DEFAULT_NIGHTLY_TIME_ZONE,
    },
    ...(targetVersion ? { targetVersion } : {}),
    ...(categories.length > 0 ? { categories } : {}),
  }
}

export interface PlanPreviewParams {
  pool: Pick<pg.Pool, 'query' | 'connect'>
  /** The seed suite (evals/seeds): seeds per cell and the cell → OWASP mapping. */
  seeds: PlanningSeed[]
  config: PlanPreviewConfig
  now: Date
  /** The window to plan for; defaults to the next window after `now` (the cron passes its own). */
  scheduledFor?: Date | undefined
}

export interface PlanPreviewResult {
  /** The single scheduled cron row the dashboard reads. */
  nightlyRunId: number
  /** True when this call inserted the row; false when it refreshed it. */
  created: boolean
  scheduledFor: string
  plan: NightlyPlan
}

/** Builds tonight's plan from Postgres without executing or persisting anything. */
export async function buildPreviewPlan(params: Omit<PlanPreviewParams, 'pool'> & { pool: Pick<pg.Pool, 'query'> }): Promise<{ plan: NightlyPlan; scheduledFor: Date }> {
  const { config, now } = params
  const repo = new PgPlanningRepository(params.pool)

  const owaspByCell = buildCellOwaspMap(params.seeds)
  const missing = unmappedCells(owaspByCell)
  if (missing.length > 0) {
    throw new Error(`Taxonomy cells with no OWASP mapping in the seed suite: ${missing.join(', ')}`)
  }
  const seedsByCell: Record<string, string[]> = {}
  params.seeds.forEach((seed) => {
    ;(seedsByCell[`${seed.category}/${seed.subcategory}`] ??= []).push(seed.id)
  })

  const scheduledFor = params.scheduledFor ?? nextNightlyWindow(now, config.window)
  const runDate = scheduledFor.toISOString().slice(0, 10)
  const notes: string[] = []

  // The operator's in-app budget wins; the configured value is the fallback.
  const operatorBudget = await repo.getNightlyBudgetUsd()
  const budgetUsd = operatorBudget ?? config.budgetUsd
  notes.push(
    operatorBudget === null
      ? `Envelope $${budgetUsd} from configuration (no platform_settings budget set).`
      : `Envelope $${budgetUsd} from platform_settings (operator-set).`,
  )

  const target = await repo.findTargetVersion(config.targetVersion)
  const targetVersion = config.targetVersion ?? target?.version ?? 'unknown'
  if (target === null) {
    notes.push(`No recorded target version${config.targetVersion ? ` ${config.targetVersion}` : ''}; every cell is treated as never run.`)
  }

  const lastRun = await repo.lastFinishedRun()
  const targetChanged = lastRun?.targetVersion != null && lastRun.targetVersion !== targetVersion
  if (targetChanged) {
    notes.push(`Target version changed ${lastRun?.targetVersion} -> ${targetVersion}: full regression suite owed.`)
  }
  const regressions = await repo.getOwedRegressions({ targetChanged, since: lastRun?.endedAt ?? null })

  // A rerun without its own estimate is priced like the dashboard's: one exploit, majority-of-R replays.
  const rerunFallbackUsd = Number((REGRESSION_REPLAYS * config.costPerAttemptUsd).toFixed(6))
  const operatorRequests = (await repo.previewOperatorRequests(runDate)).map((req) =>
    req.kind === 'rerun' && req.estimatedCostUsd === undefined ? { ...req, estimatedCostUsd: rerunFallbackUsd } : req,
  )

  const coverageCells = scopeCellsToCategories(
    await repo.getCoverageCells(target?.id ?? -1, config.maxAttemptsPerCampaign * config.costPerAttemptUsd),
    config.categories,
  )
  if (config.categories) {
    notes.push(`Coverage scoped to ${config.categories.join(', ')} (PLAN_CATEGORIES).`)
  }

  const plan = buildNightlyPlan({
    trigger: 'cron',
    targetVersion,
    budgetUsd,
    weights: config.weights,
    operatorRequests,
    regressions,
    coverageCells,
    seedsByCell,
    owaspByCell,
    costPerAttemptUsd: config.costPerAttemptUsd,
    maxAttemptsPerCampaign: config.maxAttemptsPerCampaign,
    topK: config.topK,
    traceId: `nightly-${runDate}-${randomUUID()}`,
    now,
  })
  plan.notes = [`Dry-run preview for the ${scheduledFor.toISOString()} window; nothing has executed.`, ...notes, ...(plan.notes ?? [])]
  return { plan, scheduledFor }
}

/**
 * Inserts or refreshes the ONE `trigger = 'cron'`, `status = 'scheduled'`
 * nightly_runs row. The row refreshed is the one the dashboard reads — the
 * latest by `scheduled_for DESC, id DESC` — so if strays exist (from before this
 * path) they are left alone and never shadow the current plan.
 */
export async function upsertScheduledNightlyPlan(
  pool: Pick<pg.Pool, 'connect'>,
  row: { scheduledFor: Date; plan: NightlyPlan },
): Promise<{ id: number; created: boolean }> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [PREVIEW_LOCK_KEY])
    const existing = await client.query(
      `SELECT id FROM nightly_runs WHERE trigger = 'cron' AND status = 'scheduled'
       ORDER BY scheduled_for DESC, id DESC LIMIT 1 FOR UPDATE`,
    )
    const existingId = existing.rows[0]?.id
    const result =
      existingId === undefined
        ? await client.query(
            `INSERT INTO nightly_runs (scheduled_for, trigger, status, plan)
             VALUES ($1, 'cron', 'scheduled', $2) RETURNING id`,
            [row.scheduledFor.toISOString(), JSON.stringify(row.plan)],
          )
        : await client.query(
            `UPDATE nightly_runs SET scheduled_for = $2, plan = $3 WHERE id = $1 RETURNING id`,
            [existingId, row.scheduledFor.toISOString(), JSON.stringify(row.plan)],
          )
    await client.query('COMMIT')
    return { id: Number(result.rows[0]?.id), created: existingId === undefined }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

/** Builds tonight's plan (dry run) and persists it to the scheduled cron row. */
export async function previewNightlyPlan(params: PlanPreviewParams): Promise<PlanPreviewResult> {
  const { plan, scheduledFor } = await buildPreviewPlan(params)
  const { id, created } = await upsertScheduledNightlyPlan(params.pool, { scheduledFor, plan })
  return { nightlyRunId: id, created, scheduledFor: scheduledFor.toISOString(), plan }
}
