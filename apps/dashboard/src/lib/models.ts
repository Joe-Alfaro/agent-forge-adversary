import type { VerdictOutcome } from '@agentforge/contracts'

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
  reportUrl?: string
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
}

export type AgentRole = 'orchestrator' | 'redteam' | 'judge' | 'documentation' | 'target'

export interface RoleSpend {
  role: AgentRole
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
