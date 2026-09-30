import type { AgentEvent } from '../lib/activity.js'
import type { ApprovalDecision, ApprovalItem } from '../lib/approvals.js'
import type { CostSummary, CoverageMatrix, MorningReport, RunSummary, TonightQueue } from '../lib/models.js'
import type { MoveDirection } from '../lib/queue.js'
import type { ResilienceTrend } from '../lib/resilience.js'
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
  /** KEY_METRICS M4 inputs per target version and rubric, for the resilience trend. */
  getResilienceTrend(): Promise<ResilienceTrend>
  /** Latest report draft per exploit, waiting at gate G4 or G5 (Section 10). */
  listApprovals(): Promise<ApprovalItem[]>
  /** Approve (publish) or reject a draft; only allowed transitions succeed. */
  decideApproval(reportId: string, decision: ApprovalDecision, reviewer: string): Promise<ApprovalItem>
}
