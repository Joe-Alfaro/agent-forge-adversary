import type { QueueItem, QueueItemKind } from './models.js'

/*
 * Tonight's queue as the Orchestrator will run it (ARCHITECTURE.md 7.0, 7.2):
 * operator requests first, in queue order, then the coverage campaigns from
 * the scheduled run's NightlyPlan in plan (priority) order. Run or cut follows
 * planner.ts: in order, an item runs if it still fits the envelope, else it is
 * cut, so a cheaper item further down can still run.
 */

/** One `coverage_campaign` item of the scheduled NightlyPlan. Read-only in the queue. */
export interface PlanCampaign {
  itemId: string
  category: string
  subcategory?: string
  owaspIds: string[]
  priority?: number
  estimatedCostUsd: number
  maxAttempts: number
  reason: string
}

/** The scheduled cron run's plan preview, as the queue page shows it. */
export interface TonightPlan {
  runId: string
  scheduledFor: string
  producedAt: string
  targetVersion: string
  budgetUsd: number
  campaigns: PlanCampaign[]
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

export interface CampaignRow extends RowBase, Omit<PlanCampaign, 'itemId' | 'estimatedCostUsd'> {
  source: 'orchestrator'
  kind: 'coverage_campaign'
}

export type TonightRow = OperatorRow | CampaignRow

type Unplanned = Omit<OperatorRow, keyof RowBase> | Omit<CampaignRow, keyof RowBase>

export function planTonightRows(
  items: readonly QueueItem[],
  campaigns: readonly PlanCampaign[],
  envelopeUsd: number,
): TonightRow[] {
  const ordered: (Unplanned & { key: string; costUsd: number })[] = [
    ...items.map((item) => ({ source: 'operator' as const, kind: item.kind, item, key: item.id, costUsd: item.estimatedCostUsd })),
    ...campaigns.map(({ itemId, estimatedCostUsd, ...rest }) => ({
      ...rest,
      source: 'orchestrator' as const,
      kind: 'coverage_campaign' as const,
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

function campaignFrom(
  value: unknown,
  owaspFor: (category: string, subcategory: string | undefined) => string[],
): PlanCampaign | undefined {
  if (!isRecord(value) || value.kind !== 'coverage_campaign') {
    return undefined
  }
  const { item_id: itemId, category, estimated_cost_usd: cost } = value
  if (typeof itemId !== 'string' || typeof category !== 'string' || typeof cost !== 'number' || cost < 0) {
    return undefined
  }
  const subcategory = typeof value.subcategory === 'string' ? value.subcategory : undefined
  const owaspIds = stringList(value.owasp_ids)
  const base: PlanCampaign = {
    itemId,
    category,
    owaspIds: owaspIds.length > 0 ? owaspIds : owaspFor(category, subcategory),
    estimatedCostUsd: cost,
    maxAttempts: typeof value.max_attempts === 'number' ? value.max_attempts : 0,
    reason: typeof value.reason === 'string' ? value.reason : '',
  }
  const withSub = subcategory === undefined ? base : { ...base, subcategory }
  return typeof value.priority === 'number' ? { ...withSub, priority: value.priority } : withSub
}

/**
 * The coverage campaigns of a NightlyPlan, read leniently: malformed items are
 * skipped and `owasp_ids` (not yet in NightlyPlan v1) falls back to `owaspFor`.
 * Operator items are ignored; the live queue is their source of truth.
 */
export function parsePlanCampaigns(
  plan: unknown,
  owaspFor: (category: string, subcategory: string | undefined) => string[],
): PlanCampaign[] {
  const items = isRecord(plan) ? plan.items : undefined
  if (!Array.isArray(items)) {
    return []
  }
  return items
    .map((item) => campaignFrom(item, owaspFor))
    .filter((entry): entry is PlanCampaign => entry !== undefined)
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
    campaigns: parsePlanCampaigns(plan, owaspFor),
    notes: stringList(plan.notes),
  }
}
