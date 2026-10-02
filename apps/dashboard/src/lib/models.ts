import type { TonightPlan } from './tonight.js'
import type { AttackCategory, AttackSubcategory, RerunSource, VerdictOutcome } from '@agentforge/contracts'

/**
 * Read models for the v1 dashboard panels. Each mirrors a table or view in
 * ARCHITECTURE.md Section 14.3 so the fixture layer can be swapped for server
 * functions without changing the components.
 */

export type RunTrigger = 'cron' | 'run_now'

export type RunStatus = 'scheduled' | 'running' | 'completed' | 'failed' | 'aborted'

/** One row of `nightly_runs` with its summary rolled up. */
export interface RunSummary {
  id: string
  trigger: RunTrigger
  status: RunStatus
  startedAt: string
  finishedAt?: string
  targetVersion: string
  attempts: number
  verdicts: Record<VerdictOutcome, number>
  newTickets: number
  regressions: number
  spendUsd: number
  hasMorningReport: boolean
  traceUrl?: string
}

/** One cell of `coverage_snapshots` for the current target version. */
export interface CoverageCell {
  category: AttackCategory
  subcategory: AttackSubcategory
  owaspIds: string[]
  attempts: number
  confirmed: number
  /** Distinct variant families (roots with at least one variant) on this version. */
  familiesExercised?: number
  lastRunAt?: string
}

/** Coverage for one target version; a new version resets sufficiency (Section 7.5). */
export interface CoverageMatrix {
  targetVersion: string
  cells: CoverageCell[]
  /** KEY_METRICS.md M5 over these cells. */
  m5: M5Summary
  /** The PRD's six categories; any other taxonomy category is an extra. */
  prdCategories: AttackCategory[]
}

export interface M5Summary {
  total: number
  covered: number
  minAttempts: number
  windowDays: number
  /** `category/subcategory` keys of the high-risk cells. */
  highRiskKeys: string[]
  /** High-risk keys that currently count as covered. */
  coveredKeys: string[]
  /** High-risk cells outside the PRD categories: shown, but not part of M5. */
  trackedKeys: string[]
}

export interface RoleSpend {
  /** `agent_events.agent`: orchestrator, redteam, judge, documentation, or target (the Co-Pilot's own calls). */
  role: string
  spendUsd: number
}

export interface RunSpend {
  runId: string
  startedAt: string
  spendUsd: number
}

/** Cost panel view: spend per run and per role, plus the projected monthly figure. */
export interface CostSummary {
  periodLabel: string
  totalUsd: number
  byRole: RoleSpend[]
  byRun: RunSpend[]
  projectedMonthlyUsd: number
}

export type QueueItemKind = 'rerun' | 'focus' | 'skip' | 'note'

/** One `operator_requests` row queued for the next run. */
export interface QueueItem {
  id: string
  kind: QueueItemKind
  exploitId?: string
  category?: AttackCategory
  requestedBy: string
  requestedAt: string
  source: RerunSource
  reason?: string
  estimatedCostUsd: number
}

/** Tonight's queue in the order the Orchestrator will take it. */
export interface TonightQueue {
  runDate: string
  envelopeUsd: number
  items: QueueItem[]
  /** False when the deployment has Run now turned off (RUN_NOW_ENABLED=false). */
  runNowEnabled: boolean
  /** The scheduled cron run's NightlyPlan preview, or null before the Orchestrator has planned tonight. */
  plan: TonightPlan | null
}

/** A run is finished, and can have a morning report, once it has completed, aborted, or failed. */
export const FINISHED_RUN_STATUSES: readonly RunStatus[] = ['completed', 'aborted', 'failed']

/** The Documentation Agent's summary of one finished run. */
export interface MorningReport {
  runId: string
  /** Aborted is normal: nightly runs stop at the spend cap. */
  status: RunStatus
  /** Why an aborted or failed run stopped, when the summary says. */
  abortReason?: string
  targetVersion: string
  generatedAt: string
  headline: string
  attempts: number
  verdicts: Record<VerdictOutcome, number>
  spendUsd: number
  newTickets: string[]
  regressions: string[]
  verifiedFixes: string[]
  queue: { ran: number; cut: number }
  notes: string[]
  /** The run's Langfuse trace (NightlyRunSummary `trace_url`), http(s) only. */
  traceUrl?: string
}
