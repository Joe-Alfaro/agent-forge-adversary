/**
 * Regenerates tonight's plan: the single scheduled cron nightly_runs row whose
 * NightlyPlan the queue reads (ARCHITECTURE.md 7.0, 7.2). The dashboard only
 * triggers it; planning itself is the Orchestrator's (agentforge-10's shared
 * plan:preview core). It makes no model calls, spends nothing, and does not
 * drain operator_requests.
 */
export interface TonightPlanner {
  planTonight(input: { now: Date; requestedBy: string }): Promise<void>
}
