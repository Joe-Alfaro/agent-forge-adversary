import { listTaxonomyCells, PRD_CATEGORIES, type TaxonomyCell } from '@agentforge/contracts'

import { mergeCoverage } from '../lib/coverage.js'
import * as fixtures from '../lib/fixtures.js'
import type { QueueItem, TonightQueue } from '../lib/models.js'
import { estimateRerunCostUsd, moveItem } from '../lib/queue.js'
import { nextRunDate } from '../lib/schedule.js'
import type { TicketRow } from '../lib/tickets.js'
import { m5Options, type QueueConfig } from './config.js'
import { computeM5 } from './m5.js'
import type { DashboardRepository } from './repository.js'
import { assertCanRecheck, assertRerunRequest, assertTransition, normalizeAssignee } from './rules.js'

export interface FixtureSeed {
  tickets: TicketRow[]
  queueItems: QueueItem[]
}

export interface FixtureRepositoryOptions {
  config: QueueConfig
  now?: () => Date
  seed?: FixtureSeed
  /** Every cell the Coverage panel must show, tested or not (defaults to AttackTaxonomy v1). */
  taxonomy?: readonly TaxonomyCell[]
}

/**
 * In-memory repository over the synthetic demo data (DASHBOARD_DATA_SOURCE=fixtures).
 * It lives in the server process, so writes survive page reloads until restart.
 * Reads return copies so callers cannot mutate the store.
 */
export function createFixtureRepository({
  config,
  now = () => new Date(),
  seed = { tickets: fixtures.tickets, queueItems: fixtures.queueItems },
  taxonomy = listTaxonomyCells(),
}: FixtureRepositoryOptions): DashboardRepository {
  const store = structuredClone(seed)

  function findTicket(id: string): TicketRow {
    const ticket = store.tickets.find((row) => row.id === id)
    if (!ticket) {
      throw new Error(`Unknown ticket ${id}`)
    }
    return ticket
  }

  function queue(): TonightQueue {
    return structuredClone({
      runDate: nextRunDate(now(), config),
      envelopeUsd: config.envelopeUsd,
      items: store.queueItems,
    })
  }

  return {
    async listTickets() {
      return structuredClone(store.tickets)
    },

    async getTicket(id) {
      const ticket = store.tickets.find((row) => row.id === id)
      return ticket ? structuredClone(ticket) : null
    },

    async updateTicket(id, update) {
      const ticket = findTicket(id)
      assertTransition(ticket.status, update.status)
      const assignee = normalizeAssignee(update.assignee)
      const { assignee: _previous, ...rest } = ticket
      const updated: TicketRow = assignee ? { ...rest, status: update.status, assignee } : { ...rest, status: update.status }
      store.tickets = store.tickets.map((row) => (row.id === id ? updated : row))
      return structuredClone(updated)
    },

    async listRuns() {
      return structuredClone(fixtures.runs)
    },

    async getMorningReport(runId) {
      const report = fixtures.morningReports.find((row) => row.runId === runId)
      return report ? structuredClone(report) : null
    },

    async getCoverage() {
      const coverage = structuredClone(fixtures.coverage)
      const cells = mergeCoverage(coverage.cells, taxonomy)
      return { ...coverage, cells, m5: computeM5(cells, m5Options(config, now())), prdCategories: [...PRD_CATEGORIES] }
    },

    async getCost() {
      return structuredClone(fixtures.cost)
    },

    async getQueue() {
      return queue()
    },

    async enqueueRerun(input) {
      const { request, exploitId } = assertRerunRequest(input)
      const ticket = findTicket(exploitId)
      const alreadyQueued = store.queueItems.some((item) => item.kind === 'rerun' && item.exploitId === exploitId)
      assertCanRecheck(exploitId, ticket.status, alreadyQueued)
      const base: QueueItem = {
        id: request.message_id,
        kind: 'rerun',
        exploitId,
        requestedBy: request.requested_by,
        requestedAt: now().toISOString(),
        source: request.source,
        estimatedCostUsd: estimateRerunCostUsd(ticket.familySize),
      }
      const item = request.reason ? { ...base, reason: request.reason } : base
      store.queueItems = [...store.queueItems, item]
      return queue()
    },

    async removeQueueItem(id) {
      store.queueItems = store.queueItems.filter((item) => item.id !== id)
      return queue()
    },

    async moveQueueItem(id, direction) {
      store.queueItems = moveItem(store.queueItems, id, direction)
      return queue()
    },
  }
}
