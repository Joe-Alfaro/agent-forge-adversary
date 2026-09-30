import { listTaxonomyCells, PRD_CATEGORIES, type TaxonomyCell } from '@agentforge/contracts'

import { type ApprovalItem, buildApprovalItem, type ReportRecord, sortApprovals } from '../lib/approvals.js'
import { mergeCoverage } from '../lib/coverage.js'
import * as fixtures from '../lib/fixtures.js'
import type { QueueItem, TonightQueue } from '../lib/models.js'
import { estimateRerunCostUsd, moveItem } from '../lib/queue.js'
import { nextRunDate } from '../lib/schedule.js'
import type { TicketRow } from '../lib/tickets.js'
import { m5Options, type QueueConfig } from './config.js'
import { computeM5 } from './m5.js'
import type { DashboardRepository } from './repository.js'
import {
  assertCanRecheck,
  assertReportDecision,
  assertRerunRequest,
  assertTransition,
  normalizeAssignee,
} from './rules.js'

const DAY_MS = 86_400_000

/** The day the fixture timestamps were written for. Reads shift them by whole days to today. */
const FIXTURE_DAY = Date.parse('2026-09-29T00:00:00Z')

/** Whole days between the fixture day and `now`, so times of day are preserved. */
function dayOffsetMs(now: Date): number {
  return Math.floor((now.getTime() - FIXTURE_DAY) / DAY_MS) * DAY_MS
}

function shift(iso: string, offsetMs: number): string {
  return new Date(Date.parse(iso) + offsetMs).toISOString()
}

function shiftOptional<T extends object, K extends keyof T & string>(value: T, key: K, offsetMs: number): T {
  const iso = value[key]
  return typeof iso === 'string' ? { ...value, [key]: shift(iso, offsetMs) } : value
}

export interface FixtureSeed {
  tickets: TicketRow[]
  queueItems: QueueItem[]
  reports?: ReportRecord[]
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
  seed = { tickets: fixtures.tickets, queueItems: fixtures.queueItems, reports: fixtures.reports },
  taxonomy = listTaxonomyCells(),
}: FixtureRepositoryOptions): DashboardRepository {
  // Seeded queue items move once, at creation; items enqueued later already use now().
  const createdOffset = dayOffsetMs(now())
  const store = {
    tickets: structuredClone(seed.tickets),
    queueItems: seed.queueItems.map((item) => ({ ...item, requestedAt: shift(item.requestedAt, createdOffset) })),
    reports: (seed.reports ?? []).map((report) =>
      shiftOptional({ ...report, createdAt: shift(report.createdAt, createdOffset) }, 'publishedAt', createdOffset),
    ),
  }

  function approvalItem(report: ReportRecord): ApprovalItem {
    const ticket = findTicket(report.exploitId)
    const fields = {
      reportId: report.id,
      exploitId: report.exploitId,
      version: report.version,
      severity: ticket.severity,
      category: ticket.category,
      title: report.title,
      status: report.status,
      draftedAt: report.createdAt,
    }
    const withApprover = report.approvedBy ? { ...fields, approvedBy: report.approvedBy } : fields
    return buildApprovalItem(report.publishedAt ? { ...withApprover, publishedAt: report.publishedAt } : withApprover)
  }

  function isLatestVersion(report: ReportRecord): boolean {
    return store.reports.every((other) => other.exploitId !== report.exploitId || other.version <= report.version)
  }

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
      const offset = dayOffsetMs(now())
      return fixtures.runs.map((run) =>
        shiftOptional({ ...structuredClone(run), startedAt: shift(run.startedAt, offset) }, 'finishedAt', offset),
      )
    },

    async getMorningReport(runId) {
      const report = fixtures.morningReports.find((row) => row.runId === runId)
      if (!report) {
        return null
      }
      return { ...structuredClone(report), generatedAt: shift(report.generatedAt, dayOffsetMs(now())) }
    },

    async getCoverage() {
      const offset = dayOffsetMs(now())
      const coverage = structuredClone(fixtures.coverage)
      const shifted = coverage.cells.map((cell) => shiftOptional(cell, 'lastRunAt', offset))
      const cells = mergeCoverage(shifted, taxonomy)
      return { ...coverage, cells, m5: computeM5(cells, m5Options(config, now())), prdCategories: [...PRD_CATEGORIES] }
    },

    async getCost() {
      const offset = dayOffsetMs(now())
      const cost = structuredClone(fixtures.cost)
      return { ...cost, byRun: cost.byRun.map((run) => ({ ...run, startedAt: shift(run.startedAt, offset) })) }
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

    async listApprovals() {
      const drafts = store.reports.filter((report) => report.status === 'draft' && isLatestVersion(report))
      return sortApprovals(drafts.map(approvalItem))
    },

    async decideApproval(reportId, decision, reviewer) {
      const report = store.reports.find((row) => row.id === reportId)
      if (!report) {
        throw new Error(`Unknown report ${reportId}`)
      }
      const status = assertReportDecision(report.status, decision)
      const decided: ReportRecord =
        status === 'published'
          ? { ...report, status, approvedBy: reviewer, publishedAt: now().toISOString() }
          : { ...report, status, approvedBy: reviewer }
      store.reports = store.reports.map((row) => (row.id === reportId ? decided : row))
      return approvalItem(decided)
    },
  }
}
