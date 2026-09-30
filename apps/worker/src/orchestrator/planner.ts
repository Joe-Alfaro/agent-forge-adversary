import { randomUUID } from 'node:crypto'

import {
  validateNightlyPlan,
  type NightlyPlan,
  type NightlyPlanItem,
  type OperatorRequestKind,
  type PriorityTerms,
  type RegressionCause,
} from '@agentforge/contracts'

import { rankCells, type CoverageCellInput } from './priority.js'

/**
 * The Orchestrator nightly planner (ARCHITECTURE 7.0, 7.2). It composes the
 * night's plan in priority order — operator rerun requests first, then
 * regressions owed to a changed target or to tickets moved to `fixed`, then
 * coverage-driven campaigns ranked by the priority score — and marks items
 * `run` or `cut` against the nightly budget envelope. The plan is written before
 * anything executes, so the dashboard can show what will run and what was cut.
 *
 * Operator directives shape the plan: `skip` drops a category's coverage cells,
 * `focus` biases toward a category, `note` is recorded, and `rerun` becomes a
 * prioritized targeted campaign. It cannot enable new categories or raise the
 * envelope (ARCHITECTURE 4.1 decision authority) — those stay operator actions.
 */

export interface QueuedRequest {
  id: string
  kind: OperatorRequestKind
  exploit_id?: string
  category?: string
  subcategory?: string
  reason?: string
  /**
   * operator_requests.estimated_cost_usd (the dashboard's family-size estimate),
   * so planner and dashboard agree on run/cut. 0 when the row has none.
   */
  estimatedCostUsd?: number
  /** The target exploit's stored OWASP ids, preferred over the cell mapping. */
  owaspIds?: string[]
}

/** A regression the Orchestrator owes tonight (ARCHITECTURE 7.0 steps 2–3, 7.4). */
export interface RegressionOwed {
  exploitId: string
  category: string
  subcategory?: string
  cause: RegressionCause
  owaspIds?: string[]
  /** Seeds to replay; defaults to the exploit id (replayed from its min_repro). */
  seedCaseIds?: string[]
}

/** Replays per exploit in a regression re-check (Section 9.2 majority vote). */
export const REGRESSION_REPLAYS = 3

export interface PlannerInputs {
  trigger: 'cron' | 'run_now'
  targetVersion: string
  budgetUsd: number
  weights: PriorityTerms
  /** Already drained in queue order (position NULLS LAST, created_at). */
  operatorRequests: QueuedRequest[]
  /** Owed regressions, in any order; target-change regressions are taken first. */
  regressions?: RegressionOwed[]
  /**
   * Cell → OWASP ids (see owasp.ts). When supplied, every item whose cell is
   * known carries `owasp_ids`, and a coverage cell with no mapping is an error.
   */
  owaspByCell?: Record<string, string[]>
  /** Replays per regression item; default {@link REGRESSION_REPLAYS}. */
  regressionReplays?: number
  coverageCells: CoverageCellInput[]
  /** Seed case ids per `category/subcategory` cell key. */
  seedsByCell: Record<string, string[]>
  costPerAttemptUsd: number
  maxAttemptsPerCampaign: number
  /** Number of top-ranked cells handed to the campaign stage. */
  topK: number
  messageId?: string
  traceId: string
  now: Date
}

function cellKey(category: string, subcategory: string): string {
  return `${category}/${subcategory}`
}

const CAUSE_ORDER: Record<RegressionCause, number> = { target_changed: 0, ticket_fixed: 1 }

function owaspFor(inputs: PlannerInputs, own: string[] | undefined, category: string, subcategory?: string): string[] | undefined {
  if (own && own.length > 0) return [...new Set(own)]
  if (!subcategory) return undefined
  const mapped = inputs.owaspByCell?.[cellKey(category, subcategory)]
  return mapped && mapped.length > 0 ? mapped : undefined
}

function owaspField(ids: string[] | undefined): { owasp_ids?: string[] } {
  return ids ? { owasp_ids: ids } : {}
}

export function buildNightlyPlan(inputs: PlannerInputs): NightlyPlan {
  const notes: string[] = []
  const items: NightlyPlanItem[] = []
  const costPerAttempt = inputs.costPerAttemptUsd

  // Operator directives that reshape the coverage stage.
  const skipCategories = new Set<string>()
  const focusCategories = new Set<string>()
  inputs.operatorRequests.forEach((req) => {
    if (req.kind === 'skip' && req.category) {
      skipCategories.add(req.category)
      notes.push(`Operator skipped category ${req.category} tonight.`)
    }
    if (req.kind === 'focus' && req.category) {
      focusCategories.add(req.category)
      notes.push(`Operator focus on ${req.category}.`)
    }
    if (req.kind === 'note' && req.reason) {
      notes.push(`Operator note: ${req.reason}`)
    }
  })

  // 1) Operator rerun requests, in queue order, as targeted campaigns.
  inputs.operatorRequests
    .filter((req) => req.kind === 'rerun')
    .forEach((req) => {
      const category = req.category ?? 'unknown'
      const key = req.subcategory ? cellKey(category, req.subcategory) : undefined
      items.push({
        item_id: `req-${req.id}`,
        kind: 'operator_request',
        request_id: req.id,
        request_kind: 'rerun',
        ...(req.exploit_id ? { exploit_id: req.exploit_id } : {}),
        category,
        ...(req.subcategory ? { subcategory: req.subcategory } : {}),
        ...owaspField(owaspFor(inputs, req.owaspIds, category, req.subcategory)),
        seed_case_ids: (key && inputs.seedsByCell[key]) || [],
        max_attempts: inputs.maxAttemptsPerCampaign,
        estimated_cost_usd: req.estimatedCostUsd ?? 0,
        decision: 'run',
        reason: `operator rerun${req.exploit_id ? ` for ${req.exploit_id}` : ''}`,
      })
    })

  // 2) Regressions owed to a changed target, then to tickets moved to `fixed`.
  // An exploit the operator already queued a rerun for is not planned twice.
  const replays = inputs.regressionReplays ?? REGRESSION_REPLAYS
  const planned = new Set(items.map((i) => i.exploit_id).filter((id): id is string => id !== undefined))
  ;[...(inputs.regressions ?? [])]
    .sort((a, b) => CAUSE_ORDER[a.cause] - CAUSE_ORDER[b.cause])
    .forEach((reg) => {
      if (planned.has(reg.exploitId)) return
      planned.add(reg.exploitId)
      items.push({
        item_id: `regress-${reg.exploitId}`,
        kind: 'regression',
        regression_cause: reg.cause,
        exploit_id: reg.exploitId,
        category: reg.category,
        ...(reg.subcategory ? { subcategory: reg.subcategory } : {}),
        ...owaspField(owaspFor(inputs, reg.owaspIds, reg.category, reg.subcategory)),
        seed_case_ids: reg.seedCaseIds ?? [reg.exploitId],
        max_attempts: replays,
        estimated_cost_usd: Number((replays * costPerAttempt).toFixed(6)),
        decision: 'run',
        reason:
          reg.cause === 'target_changed'
            ? `regression for ${reg.exploitId}: target version changed since the last run`
            : `regression for ${reg.exploitId}: ticket moved to fixed since the last run`,
      })
    })

  // 3) Coverage-driven campaigns, ranked by the priority score.
  const candidates = inputs.coverageCells.filter((c) => !skipCategories.has(c.category))
  const ranked = rankCells(candidates, inputs.weights)
    .map((r) => (focusCategories.size > 0 && focusCategories.has(r.category) ? { ...r, priority: r.priority + 1000 } : r))
    .sort((a, b) => b.priority - a.priority)
    .slice(0, inputs.topK)

  ranked.forEach((cell) => {
    const key = cellKey(cell.category, cell.subcategory)
    const owasp = owaspFor(inputs, undefined, cell.category, cell.subcategory)
    if (inputs.owaspByCell && !owasp) {
      throw new Error(`Coverage cell ${key} has no OWASP mapping; every campaign must carry one.`)
    }
    items.push({
      item_id: `cell-${key}`,
      kind: 'coverage_campaign',
      category: cell.category,
      subcategory: cell.subcategory,
      ...owaspField(owasp),
      priority: cell.priority,
      score: cell.score,
      seed_case_ids: inputs.seedsByCell[key] ?? [],
      max_attempts: inputs.maxAttemptsPerCampaign,
      estimated_cost_usd: inputs.maxAttemptsPerCampaign * costPerAttempt,
      decision: 'run',
      reason: `coverage priority ${cell.priority.toFixed(3)}`,
    })
  })

  // 4) Budget envelope: run items in order until the envelope is consumed; the
  // rest are cut. Operator reruns and owed regressions come first, so they win
  // the budget.
  let spent = 0
  items.forEach((item) => {
    const cost = item.estimated_cost_usd
    if (spent + cost <= inputs.budgetUsd) {
      item.decision = 'run'
      spent += cost
    } else {
      item.decision = 'cut'
      item.reason = `${item.reason}; cut: over budget envelope ($${inputs.budgetUsd})`
    }
  })

  const runItems = items.filter((i) => i.decision === 'run')
  const plan: NightlyPlan = {
    schema_version: '1',
    message_id: inputs.messageId ?? randomUUID(),
    trace_id: inputs.traceId,
    produced_by: 'orchestrator',
    produced_at: inputs.now.toISOString(),
    trigger: inputs.trigger,
    target_version: inputs.targetVersion,
    budget_usd: inputs.budgetUsd,
    estimated_cost_usd: Number(runItems.reduce((s, i) => s + i.estimated_cost_usd, 0).toFixed(6)),
    weights: inputs.weights,
    items,
    run_count: runItems.length,
    cut_count: items.length - runItems.length,
    ...(notes.length > 0 ? { notes } : {}),
  }

  const check = validateNightlyPlan(plan)
  if (!check.valid) {
    throw new Error(`Planner produced an invalid NightlyPlan: ${check.errors.join('; ')}`)
  }
  return plan
}
