import type { RerunRequest } from '@agentforge/contracts'

import type { AgentEvent } from './activity.js'
import type { ApprovalDecision, ApprovalItem } from './approvals.js'
import type { ResilienceTrend } from './resilience.js'
import type { CostSummary, CoverageMatrix, MorningReport, RunSummary, TonightQueue } from './models.js'
import type { MoveDirection } from './queue.js'
import {
  decideApprovalFn,
  enqueueRerunFn,
  getCostFn,
  getCoverageFn,
  getDataSourceModeFn,
  getMorningReportFn,
  getQueueFn,
  getResilienceTrendFn,
  getTicketFn,
  listAgentEventsFn,
  listApprovalsFn,
  listRunsFn,
  listTicketsFn,
  moveQueueItemFn,
  removeQueueItemFn,
  updateTicketFn,
} from './server-fns.js'
import type { TicketRow, TicketUpdate } from './tickets.js'

export type { TicketUpdate } from './tickets.js'

/*
 * The dashboard's data seam. Every call is a TanStack Start server function;
 * the server picks Postgres or the demo fixtures from DASHBOARD_DATA_SOURCE.
 * Component tests replace this module with an in-memory implementation.
 */

export type DataSourceMode = 'fixtures' | 'postgres'

export function fetchDataSourceMode(): Promise<DataSourceMode> {
  return getDataSourceModeFn()
}

export function fetchTickets(): Promise<TicketRow[]> {
  return listTicketsFn()
}

export function fetchTicket(id: string): Promise<TicketRow | null> {
  return getTicketFn({ data: id })
}

export function fetchRuns(): Promise<RunSummary[]> {
  return listRunsFn()
}

export function fetchCoverage(): Promise<CoverageMatrix> {
  return getCoverageFn()
}

export function fetchCost(): Promise<CostSummary> {
  return getCostFn()
}

export function fetchQueue(): Promise<TonightQueue> {
  return getQueueFn()
}

export function fetchMorningReport(runId: string): Promise<MorningReport | null> {
  return getMorningReportFn({ data: runId })
}

export function updateTicket(id: string, update: TicketUpdate): Promise<TicketRow> {
  return updateTicketFn({ data: { id, update } })
}

export function enqueueRerun(request: RerunRequest): Promise<TonightQueue> {
  return enqueueRerunFn({ data: request })
}

export function removeQueueItem(id: string): Promise<TonightQueue> {
  return removeQueueItemFn({ data: id })
}

export function moveQueueItem(id: string, direction: MoveDirection): Promise<TonightQueue> {
  return moveQueueItemFn({ data: { id, direction } })
}

export function fetchApprovals(): Promise<ApprovalItem[]> {
  return listApprovalsFn()
}

export function decideApproval(reportId: string, decision: ApprovalDecision): Promise<ApprovalItem> {
  return decideApprovalFn({ data: { reportId, decision } })
}

export function fetchResilienceTrend(): Promise<ResilienceTrend> {
  return getResilienceTrendFn()
}

export function fetchAgentEvents(): Promise<AgentEvent[]> {
  return listAgentEventsFn()
}
