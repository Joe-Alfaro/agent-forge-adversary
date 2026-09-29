import type { RerunRequest } from '@agentforge/contracts'

import * as fixtures from './fixtures.js'
import type { CostSummary, CoverageMatrix, MorningReport, RunSummary, TonightQueue } from './models.js'
import { estimateRerunCostUsd, type MoveDirection, moveItem } from './queue.js'
import { canRecheckTonight, type ExploitStatus, nextStatuses, type TicketRow } from './tickets.js'

/*
 * The dashboard's only data seam. v1 and v2 run against an in-memory copy of
 * the synthetic fixtures; swapping to TanStack Start server functions backed by
 * @agentforge/db means replacing these function bodies and nothing else.
 * Reads return copies so callers cannot mutate the store. Writes live only in
 * the current JavaScript context and reset on a full page reload.
 */

interface Store {
  tickets: TicketRow[]
  queue: TonightQueue
}

function freshStore(): Store {
  return { tickets: structuredClone(fixtures.tickets), queue: structuredClone(fixtures.queue) }
}

const store: Store = freshStore()

/** Restores the fixtures; used by tests to isolate cases. */
export function resetStore(): void {
  Object.assign(store, freshStore())
}

function findTicket(id: string): TicketRow {
  const ticket = store.tickets.find((row) => row.id === id)
  if (!ticket) {
    throw new Error(`Unknown ticket ${id}`)
  }
  return ticket
}

export async function fetchTickets(): Promise<TicketRow[]> {
  return structuredClone(store.tickets)
}

export async function fetchTicket(id: string): Promise<TicketRow | null> {
  const ticket = store.tickets.find((row) => row.id === id)
  if (!ticket) {
    return null
  }
  return structuredClone(ticket)
}

export async function fetchRuns(): Promise<RunSummary[]> {
  return structuredClone(fixtures.runs)
}

export async function fetchCoverage(): Promise<CoverageMatrix> {
  return structuredClone(fixtures.coverage)
}

export async function fetchCost(): Promise<CostSummary> {
  return structuredClone(fixtures.cost)
}

export async function fetchQueue(): Promise<TonightQueue> {
  return structuredClone(store.queue)
}

export async function fetchMorningReport(runId: string): Promise<MorningReport | null> {
  const report = fixtures.morningReports.find((row) => row.runId === runId)
  if (!report) {
    return null
  }
  return structuredClone(report)
}

export interface TicketUpdate {
  status: ExploitStatus
  /** A blank name clears the assignee. */
  assignee: string
}

export async function updateTicket(id: string, update: TicketUpdate): Promise<TicketRow> {
  const ticket = findTicket(id)
  if (update.status !== ticket.status && !nextStatuses(ticket.status).includes(update.status)) {
    throw new Error(`Status change ${ticket.status} → ${update.status} is not allowed`)
  }
  const assignee = update.assignee.trim()
  const { assignee: _previous, ...rest } = ticket
  const updated: TicketRow = assignee ? { ...rest, status: update.status, assignee } : { ...rest, status: update.status }
  store.tickets = store.tickets.map((row) => (row.id === id ? updated : row))
  return structuredClone(updated)
}

/** Accepts a `RerunRequest v1` and appends it to tonight's queue. */
export async function enqueueRerun(request: RerunRequest): Promise<TonightQueue> {
  const exploitId = request.target.exploit_id
  if (request.target.kind !== 'exploit' || !exploitId) {
    throw new Error('Only exploit re-checks can be queued from the dashboard')
  }
  const ticket = findTicket(exploitId)
  if (!canRecheckTonight(ticket.status)) {
    throw new Error(`${exploitId} is ${ticket.status} and cannot be re-checked`)
  }
  if (store.queue.items.some((item) => item.kind === 'rerun' && item.exploitId === exploitId)) {
    throw new Error(`${exploitId} is already queued for tonight`)
  }
  const base = {
    id: request.message_id,
    kind: 'rerun' as const,
    exploitId,
    requestedBy: request.requested_by,
    requestedAt: new Date().toISOString(),
    source: request.source,
    estimatedCostUsd: estimateRerunCostUsd(ticket.familySize),
  }
  const item = request.reason ? { ...base, reason: request.reason } : base
  store.queue = { ...store.queue, items: [...store.queue.items, item] }
  return structuredClone(store.queue)
}

export async function removeQueueItem(id: string): Promise<TonightQueue> {
  store.queue = { ...store.queue, items: store.queue.items.filter((item) => item.id !== id) }
  return structuredClone(store.queue)
}

export async function moveQueueItem(id: string, direction: MoveDirection): Promise<TonightQueue> {
  store.queue = { ...store.queue, items: moveItem(store.queue.items, id, direction) }
  return structuredClone(store.queue)
}
