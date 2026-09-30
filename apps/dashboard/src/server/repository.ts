import type { AgentEvent } from '../lib/activity.js'
import type { ApprovalDecision, ApprovalItem } from '../lib/approvals.js'
import type { JudgeHealth, ReviewInput, ReviewItem, ReviewResolution } from '../lib/judge.js'
import type { CostSummary, CoverageMatrix, MorningReport, RunSummary, TonightQueue } from '../lib/models.js'
import type { MoveDirection } from '../lib/queue.js'
import type { ResilienceTrend } from '../lib/resilience.js'
import type { RunNowScope } from '../lib/run-now.js'
import type { TicketRow, TicketUpdate } from '../lib/tickets.js'

/**
 * Everything the dashboard reads and writes. The fixture and Postgres
 * implementations must behave identically; server functions pick one by
 * DASHBOARD_DATA_SOURCE.
 */
export interface DashboardRepository {
  listTickets(): Promise<TicketRow[]>
  getTicket(id: string): Promise<TicketRow | null>
  updateTicket(id: string, update: TicketUpdate): Promise<TicketRow>
  listRuns(): Promise<RunSummary[]>
  getRun(runId: string): Promise<RunSummary | null>
  /**
   * Gate G10: inserts one nightly_runs row (trigger run_now, status scheduled,
   * plan RunNowPlan) for the executor to pick up. Never runs anything itself.
   */
  runNow(scope: RunNowScope, requestedBy: string): Promise<RunSummary>
  getMorningReport(runId: string): Promise<MorningReport | null>
  getCoverage(): Promise<CoverageMatrix>
  getCost(): Promise<CostSummary>
  getQueue(): Promise<TonightQueue>
  /** Takes untrusted input; implementations validate it against RerunRequest v1. */
  enqueueRerun(request: unknown): Promise<TonightQueue>
  removeQueueItem(id: string): Promise<TonightQueue>
  moveQueueItem(id: string, direction: MoveDirection): Promise<TonightQueue>
  /** The newest `limit` agent_events, newest first. */
  listAgentEvents(limit: number): Promise<AgentEvent[]>
  /** Judge verdicts flagged needs_review with no human decision yet, oldest first. */
  listNeedsReview(): Promise<ReviewItem[]>
  /** Records a human verdict and a ground-truth label (Section 8.4, gate G7). */
  resolveReview(verdictId: string, input: ReviewInput, reviewer: string): Promise<ReviewResolution>
  getJudgeHealth(): Promise<JudgeHealth>
  /** KEY_METRICS M4 inputs per target version and rubric, for the resilience trend. */
  getResilienceTrend(): Promise<ResilienceTrend>
  /** Latest report draft per exploit, waiting at gate G4 or G5 (Section 10). */
  listApprovals(): Promise<ApprovalItem[]>
  /** Approve (publish) or reject a draft; only allowed transitions succeed. */
  decideApproval(reportId: string, decision: ApprovalDecision, reviewer: string): Promise<ApprovalItem>
}
