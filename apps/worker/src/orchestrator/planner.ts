import { randomUUID } from 'node:crypto'

import {
  validateNightlyPlan,
  type NightlyPlan,
  type NightlyPlanItem,
  type OperatorRequestKind,
  type PriorityTerms,
} from '@agentforge/contracts'

import { rankCells, type CoverageCellInput } from './priority.js'

/**
 * The Orchestrator nightly planner (ARCHITECTURE 7.0, 7.2). It composes the
 * night's plan in priority order — operator rerun requests first, then
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
}

export interface PlannerInputs {
  trigger: 'cron' | 'run_now'
  targetVersion: string
  budgetUsd: number
  weights: PriorityTerms
  /** Already drained in queue order (position NULLS LAST, created_at). */
  operatorRequests: QueuedRequest[]
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

export function buildNightlyPlan(inputs: PlannerInputs): NightlyPlan {
  const notes: string[] = []
  const items: NightlyPlanItem[] = []

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
        seed_case_ids: (key && inputs.seedsByCell[key]) || [],
        max_attempts: inputs.maxAttemptsPerCampaign,
        estimated_cost_usd: 0,
        decision: 'run',
        reason: `operator rerun${req.exploit_id ? ` for ${req.exploit_id}` : ''}`,
      })
    })

  // 2) Coverage-driven campaigns, ranked by the priority score.
  const candidates = inputs.coverageCells.filter((c) => !skipCategories.has(c.category))
  const ranked = rankCells(candidates, inputs.weights)
    .map((r) => (focusCategories.size > 0 && focusCategories.has(r.category) ? { ...r, priority: r.priority + 1000 } : r))
    .sort((a, b) => b.priority - a.priority)
    .slice(0, inputs.topK)

  ranked.forEach((cell) => {
    const key = cellKey(cell.category, cell.subcategory)
    items.push({
      item_id: `cell-${key}`,
      kind: 'coverage_campaign',
      category: cell.category,
      subcategory: cell.subcategory,
      priority: cell.priority,
      score: cell.score,
      seed_case_ids: inputs.seedsByCell[key] ?? [],
      max_attempts: inputs.maxAttemptsPerCampaign,
      estimated_cost_usd: inputs.maxAttemptsPerCampaign * inputs.costPerAttemptUsd,
      decision: 'run',
      reason: `coverage priority ${cell.priority.toFixed(3)}`,
    })
  })

  // 3) Budget envelope: run items in order until the envelope is consumed; the
  // rest are cut. Operator reruns come first, so they win the budget.
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
