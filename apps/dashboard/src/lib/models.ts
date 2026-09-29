import type { RerunSource, VerdictOutcome } from '@agentforge/contracts'

import type { M5Summary } from './m5.js'

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
  category: string
  subcategory: string
  owaspIds: string[]
  attempts: number
  confirmed: number
  lastRunAt?: string
}

/** Coverage for one target version; a new version resets sufficiency (Section 7.5). */
export interface CoverageMatrix {
  targetVersion: string
  cells: CoverageCell[]
  /** KEY_METRICS.md M5 over these cells. */
  m5: M5Summary
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
  category?: string
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
}

export interface PlannedQueueItem extends QueueItem {
  position: number
  cumulativeUsd: number
  /** True when the item falls outside tonight's budget envelope and will be cut. */
  cut: boolean
}

/** The Documentation Agent's summary of one finished run. */
export interface MorningReport {
  runId: string
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
}
