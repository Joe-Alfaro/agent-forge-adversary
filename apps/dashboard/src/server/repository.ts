import type { CostSummary, CoverageMatrix, MorningReport, RunSummary, TonightQueue } from '../lib/models.js'
import type { MoveDirection } from '../lib/queue.js'
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
}
