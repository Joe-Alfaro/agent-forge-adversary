import type { QueueItem, QueueItemKind } from './models.js'

/*
 * Tonight's queue as the Orchestrator will run it (ARCHITECTURE.md 7.0, 7.2,
 * 7.4): operator requests first, in queue order, then the scheduled run's
 * NightlyPlan items in plan order: regressions owed, then coverage campaigns
 * by priority. Run or cut follows planner.ts: in order, an item runs if it
 * still fits the envelope, else it is cut, so a cheaper item further down can
 * still run.
 */

/** The NightlyPlan item kinds the Orchestrator generates; operator items come from the live queue. */
export type PlanItemKind = 'regression' | 'coverage_campaign'

/** Why a regression is owed tonight (NightlyPlan `regression_cause`). */
export type RegressionCause = 'target_changed' | 'ticket_fixed'

/** One Orchestrator-generated item of the scheduled NightlyPlan. Read-only in the queue. */
export interface PlanItem {
  itemId: string
  kind: PlanItemKind
  category: string
  subcategory?: string
  owaspIds: string[]
  priority?: number
  estimatedCostUsd: number
  maxAttempts: number
  reason: string
  /** Regressions only: the ticket being re-checked. */
  exploitId?: string
  regressionCause?: RegressionCause
}

/** The scheduled cron run's plan preview, as the queue page shows it. */
export interface TonightPlan {
  runId: string
  scheduledFor: string
  producedAt: string
  targetVersion: string
  budgetUsd: number
  items: PlanItem[]
  notes: string[]
}

interface RowBase {
  key: string
  position: number
  costUsd: number
  decision: 'run' | 'cut'
  /** Spend on items that run, up to and including this one. */
  cumulativeUsd: number
}

export interface OperatorRow extends RowBase {
  source: 'operator'
  kind: QueueItemKind
  item: QueueItem
}

export interface OrchestratorRow extends RowBase, Omit<PlanItem, 'itemId' | 'estimatedCostUsd'> {
  source: 'orchestrator'
}

export type TonightRow = OperatorRow | OrchestratorRow

type Unplanned = Omit<OperatorRow, keyof RowBase> | Omit<OrchestratorRow, keyof RowBase>

export function planTonightRows(
  items: readonly QueueItem[],
  planItems: readonly PlanItem[],
  envelopeUsd: number,
): TonightRow[] {
  const ordered: (Unplanned & { key: string; costUsd: number })[] = [
    ...items.map((item) => ({ source: 'operator' as const, kind: item.kind, item, key: item.id, costUsd: item.estimatedCostUsd })),
    ...planItems.map(({ itemId, estimatedCostUsd, ...rest }) => ({
      ...rest,
      source: 'orchestrator' as const,
      key: itemId,
      costUsd: estimatedCostUsd,
    })),
  ]
  return ordered.reduce<TonightRow[]>((rows, row, index) => {
    const spent = rows.at(-1)?.cumulativeUsd ?? 0
    const fits = Math.round((spent + row.costUsd) * 100) / 100 <= envelopeUsd
    const cumulativeUsd = fits ? Math.round((spent + row.costUsd) * 100) / 100 : spent
    const planned = { ...row, position: index + 1, decision: fits ? ('run' as const) : ('cut' as const), cumulativeUsd }
    return [...rows, planned as TonightRow]
  }, [])
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []
}

const PLAN_ITEM_KINDS: readonly PlanItemKind[] = ['regression', 'coverage_campaign']
const REGRESSION_CAUSES: readonly RegressionCause[] = ['target_changed', 'ticket_fixed']

function planItemFrom(
  value: unknown,
  owaspFor: (category: string, subcategory: string | undefined) => string[],
): PlanItem | undefined {
  if (!isRecord(value)) {
    return undefined
  }
  const kind = PLAN_ITEM_KINDS.find((candidate) => candidate === value.kind)
  const { item_id: itemId, category, estimated_cost_usd: cost } = value
  if (!kind || typeof itemId !== 'string' || typeof category !== 'string' || typeof cost !== 'number' || cost < 0) {
    return undefined
  }
  const subcategory = typeof value.subcategory === 'string' ? value.subcategory : undefined
  const owaspIds = stringList(value.owasp_ids)
  const base: PlanItem = {
    itemId,
    kind,
    category,
    owaspIds: owaspIds.length > 0 || kind === 'regression' ? owaspIds : owaspFor(category, subcategory),
    estimatedCostUsd: cost,
    maxAttempts: typeof value.max_attempts === 'number' ? value.max_attempts : 0,
    reason: typeof value.reason === 'string' ? value.reason : '',
  }
  const regressionCause = REGRESSION_CAUSES.find((cause) => cause === value.regression_cause)
  const optional: Partial<PlanItem> = {
    ...(subcategory === undefined ? {} : { subcategory }),
    ...(typeof value.priority === 'number' ? { priority: value.priority } : {}),
    ...(typeof value.exploit_id === 'string' ? { exploitId: value.exploit_id } : {}),
    ...(regressionCause === undefined ? {} : { regressionCause }),
  }
  return { ...base, ...optional }
}

/**
 * The Orchestrator's items of a NightlyPlan (regressions and coverage
 * campaigns) in plan order, read leniently: malformed or unknown items are
 * skipped, and a campaign without `owasp_ids` falls back to `owaspFor`.
 * Operator items are ignored; the live queue is their source of truth.
 */
export function parsePlanItems(
  plan: unknown,
  owaspFor: (category: string, subcategory: string | undefined) => string[],
): PlanItem[] {
  const items = isRecord(plan) ? plan.items : undefined
  if (!Array.isArray(items)) {
    return []
  }
  return items
    .map((item) => planItemFrom(item, owaspFor))
    .filter((entry): entry is PlanItem => entry !== undefined)
}

export interface ScheduledRunRow {
  runId: string
  scheduledFor: string
  plan: unknown
}

/** The queue page's view of a scheduled run's plan, or null when the plan is not a NightlyPlan-shaped object. */
export function parseTonightPlan(
  row: ScheduledRunRow,
  owaspFor: (category: string, subcategory: string | undefined) => string[],
): TonightPlan | null {
  const { plan } = row
  if (!isRecord(plan) || !Array.isArray(plan.items) || typeof plan.budget_usd !== 'number') {
    return null
  }
  return {
    runId: row.runId,
    scheduledFor: row.scheduledFor,
    producedAt: typeof plan.produced_at === 'string' ? plan.produced_at : row.scheduledFor,
    targetVersion: typeof plan.target_version === 'string' ? plan.target_version : 'unknown',
    budgetUsd: plan.budget_usd,
    items: parsePlanItems(plan, owaspFor),
    notes: stringList(plan.notes),
  }
}
