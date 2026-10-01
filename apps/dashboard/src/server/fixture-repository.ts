import { listTaxonomyCells, PRD_CATEGORIES, type TaxonomyCell } from '@agentforge/contracts'

import type { AgentEvent } from '../lib/activity.js'
import { type ApprovalItem, buildApprovalItem, type ReportRecord, sortApprovals } from '../lib/approvals.js'
import {
  type ReviewItem,
  type ReviewRecord,
  resolvedOutcome,
  summarizeJudgeHealth,
} from '../lib/judge.js'
import { parseNightlyBudget } from '../lib/budget.js'
import { mergeCoverage } from '../lib/coverage.js'
import * as fixtures from '../lib/fixtures.js'
import type { MorningReport, QueueItem, RunStatus, RunSummary, TonightQueue } from '../lib/models.js'
import { estimateRerunCostUsd, moveItem } from '../lib/queue.js'
import { isRunNowActive, type RunNowScope, scopedItems } from '../lib/run-now.js'
import { parseTonightPlan } from '../lib/tonight.js'
import { nextRunDate } from '../lib/schedule.js'
import type { TicketRow } from '../lib/tickets.js'
import { isRunNowEnabled, m5Options, type QueueConfig } from './config.js'
import { computeM5 } from './m5.js'
import type { DashboardRepository } from './repository.js'
import {
  assertCanRecheck,
  assertReportDecision,
  assertRerunRequest,
  assertRunNow,
  assertRunNowEnabled,
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
  events?: AgentEvent[]
  /** Verdicts waiting for a human. */
  reviews?: ReviewItem[]
  /** Reviews already settled before the store was created. */
  reviewHistory?: ReviewRecord[]
  groundTruthLabels?: number
  /** Tonight's scheduled cron run and its NightlyPlan, as plan:preview writes it. */
  scheduledPlan?: { scheduledFor: string; plan: unknown }
}

/** How long a simulated run-now stays scheduled, and when it completes, after it is requested. */
export interface RunNowTimings {
  startAfterMs: number
  finishAfterMs: number
}

const DEFAULT_RUN_NOW_TIMINGS: RunNowTimings = { startAfterMs: 5_000, finishAfterMs: 25_000 }

/** A run-now the fixture store scheduled, standing in for the executor's nightly_runs row. */
interface SimulatedRun {
  id: string
  scope: RunNowScope
  requestedBy: string
  requestedAt: string
  /** The queued requests the executor would drain, captured when the run was requested. */
  items: QueueItem[]
}

/** The synthetic demo data served in fixtures mode. */
export function demoSeed(): FixtureSeed {
  return {
    tickets: fixtures.tickets,
    queueItems: fixtures.queueItems,
    reports: fixtures.reports,
    events: fixtures.agentEvents,
    reviews: fixtures.reviewItems,
    reviewHistory: fixtures.reviewHistory,
    groundTruthLabels: fixtures.groundTruthLabels,
    scheduledPlan: fixtures.scheduledPlan,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** planner.ts boosts every cell in a focused category by this much. */
const FOCUS_BOOST = 1000

/**
 * Stands in for the Orchestrator's planner in fixtures mode: re-plans the
 * current preview against the live queue. Skipped categories drop out, focused
 * ones get the planner's +1000 boost, campaigns are re-ranked by priority after
 * the regressions, and the plan is stamped with the time and current budget.
 */
function simulatePlan(basePlan: unknown, items: readonly QueueItem[], budgetUsd: number, at: Date): Record<string, unknown> {
  const base = isRecord(basePlan) ? basePlan : {}
  const baseItems = (Array.isArray(base.items) ? base.items : []).filter(isRecord)
  const categories = (kind: QueueItem['kind']) =>
    new Set(items.filter((item) => item.kind === kind && item.category).map((item) => String(item.category)))
  const focus = categories('focus')
  const skip = categories('skip')
  const campaigns = baseItems
    .filter((item) => item.kind === 'coverage_campaign' && !skip.has(String(item.category)))
    .map((item) => {
      const raw = typeof item.priority === 'number' ? item.priority : 0
      const unboosted = raw >= FOCUS_BOOST ? raw - FOCUS_BOOST : raw
      const priority = focus.has(String(item.category)) ? unboosted + FOCUS_BOOST : unboosted
      return { ...item, priority, reason: `coverage priority ${priority.toFixed(3)}` }
    })
    .sort((a, b) => b.priority - a.priority)
  return {
    ...base,
    produced_at: at.toISOString(),
    budget_usd: budgetUsd,
    items: [...baseItems.filter((item) => item.kind === 'regression'), ...campaigns],
    notes: [
      ...[...focus].map((category) => `Operator focus on ${category}.`),
      ...[...skip].map((category) => `Operator skipped category ${category} tonight.`),
      'Re-planned from the dashboard (demo data).',
    ],
  }
}

export interface FixtureRepositoryOptions {
  config: QueueConfig
  now?: () => Date
  seed?: FixtureSeed
  /** Every cell the Coverage panel must show, tested or not (defaults to AttackTaxonomy v1). */
  taxonomy?: readonly TaxonomyCell[]
  /** Demo pacing for the simulated executor (fixtures mode only). */
  runNowTimings?: RunNowTimings
}

/**
 * In-memory repository over the synthetic demo data (DASHBOARD_DATA_SOURCE=fixtures).
 * It lives in the server process, so writes survive page reloads until restart.
 * Reads return copies so callers cannot mutate the store.
 */
export function createFixtureRepository({
  config,
  now = () => new Date(),
  seed = demoSeed(),
  taxonomy = listTaxonomyCells(),
  runNowTimings = DEFAULT_RUN_NOW_TIMINGS,
}: FixtureRepositoryOptions): DashboardRepository {
  // Seeded queue items move once, at creation; items enqueued later already use now().
  const createdOffset = dayOffsetMs(now())
  const store = {
    tickets: structuredClone(seed.tickets),
    queueItems: seed.queueItems.map((item) => ({ ...item, requestedAt: shift(item.requestedAt, createdOffset) })),
    events: seed.events ?? [],
    reviews: (seed.reviews ?? []).map((review) => ({ ...review, flaggedAt: shift(review.flaggedAt, createdOffset) })),
    reviewHistory: seed.reviewHistory ?? [],
    groundTruthLabels: seed.groundTruthLabels ?? 0,
    resolved: new Set<string>(),
    runNowRuns: [] as SimulatedRun[],
    /** A plan regenerated by "Plan tonight now"; replaces the seeded preview. */
    replanned: null as { scheduledFor: string; plan: Record<string, unknown> } | null,
    /** Stands in for platform_settings.nightly_budget_usd; starts at NIGHTLY_BUDGET_USD. */
    budgetUsd: config.envelopeUsd,
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

  /*
   * Simulated executor: a run-now is scheduled for startAfterMs, then running
   * (its requests leave the queue, as the executor drains them), then completed
   * with a summary and morning report at finishAfterMs.
   */
  function simulatedStatus(run: SimulatedRun): RunStatus {
    const elapsed = now().getTime() - Date.parse(run.requestedAt)
    if (elapsed < runNowTimings.startAfterMs) {
      return 'scheduled'
    }
    return elapsed < runNowTimings.finishAfterMs ? 'running' : 'completed'
  }

  function simulatedSummary(run: SimulatedRun): RunSummary {
    const status = simulatedStatus(run)
    const base: RunSummary = {
      id: run.id,
      trigger: 'run_now',
      status,
      startedAt: run.requestedAt,
      targetVersion: fixtures.TARGET_VERSION,
      attempts: 0,
      verdicts: { success: 0, partial: 0, fail: 0 },
      newTickets: 0,
      regressions: 0,
      spendUsd: 0,
      hasMorningReport: false,
    }
    if (status !== 'completed') {
      return base
    }
    const drained = run.items.length
    const attempts = drained * 40
    return {
      ...base,
      finishedAt: new Date(Date.parse(run.requestedAt) + runNowTimings.finishAfterMs).toISOString(),
      attempts,
      verdicts: { success: drained, partial: drained * 2, fail: attempts - drained * 3 },
      spendUsd: Math.round(run.items.reduce((sum, item) => sum + item.estimatedCostUsd, 0) * 100) / 100,
      hasMorningReport: true,
    }
  }

  function simulatedReport(run: SimulatedRun): MorningReport | null {
    const summary = simulatedSummary(run)
    if (!summary.hasMorningReport || !summary.finishedAt) {
      return null
    }
    const drained = run.items.length
    return {
      runId: run.id,
      targetVersion: summary.targetVersion,
      generatedAt: summary.finishedAt,
      headline: `Run now: ${drained} operator request${drained === 1 ? '' : 's'} drained; no new findings (simulated).`,
      attempts: summary.attempts,
      verdicts: summary.verdicts,
      spendUsd: summary.spendUsd,
      newTickets: [],
      regressions: [],
      verifiedFixes: [],
      queue: { ran: drained, cut: 0 },
      notes: [`Requested by ${run.requestedBy}. Demo data: the fixture store simulates the executor.`],
    }
  }

  /** Queued requests no started run-now has drained yet. */
  function pendingItems(): QueueItem[] {
    const drained = new Set(
      store.runNowRuns
        .filter((run) => simulatedStatus(run) !== 'scheduled')
        .flatMap((run) => run.items.map((item) => item.id)),
    )
    return store.queueItems.filter((item) => !drained.has(item.id))
  }

  function staticRuns(): RunSummary[] {
    const offset = dayOffsetMs(now())
    return fixtures.runs.map((run) =>
      shiftOptional({ ...structuredClone(run), startedAt: shift(run.startedAt, offset) }, 'finishedAt', offset),
    )
  }

  function allRuns(): RunSummary[] {
    return [...store.runNowRuns.map(simulatedSummary), ...staticRuns()].sort(
      (a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt),
    )
  }

  /** OWASP ids the demo coverage shows for a cell, for plan items that carry none. */
  function owaspFor(category: string, subcategory: string | undefined): string[] {
    return fixtures.coverage.cells.find((cell) => cell.category === category && cell.subcategory === subcategory)?.owaspIds ?? []
  }

  function tonightPlan() {
    if (store.replanned) {
      return parseTonightPlan(
        { runId: `scheduled-${nextRunDate(now(), config)}`, scheduledFor: store.replanned.scheduledFor, plan: store.replanned.plan },
        owaspFor,
      )
    }
    const scheduled = seed.scheduledPlan
    if (!scheduled) {
      return null
    }
    const plan = parseTonightPlan(
      { runId: `scheduled-${nextRunDate(now(), config)}`, scheduledFor: shift(scheduled.scheduledFor, createdOffset), plan: scheduled.plan },
      owaspFor,
    )
    return plan && { ...plan, producedAt: shift(plan.producedAt, createdOffset) }
  }

  function queue(): TonightQueue {
    return structuredClone({
      runDate: nextRunDate(now(), config),
      envelopeUsd: store.budgetUsd,
      items: pendingItems(),
      runNowEnabled: isRunNowEnabled(config),
      plan: tonightPlan(),
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
      // Only started runs; a scheduled run-now is followed by id until it starts.
      return allRuns().filter((run) => run.status !== 'scheduled')
    },

    async getRun(runId) {
      return allRuns().find((run) => run.id === runId) ?? null
    },

    async runNow(scope, requestedBy) {
      assertRunNowEnabled(isRunNowEnabled(config))
      const active = allRuns().some((run) => run.trigger === 'run_now' && isRunNowActive(run.status))
      const pending = pendingItems()
      assertRunNow(pending, scope, active)
      const run: SimulatedRun = {
        id: `run-now-${store.runNowRuns.length + 1}`,
        scope,
        requestedBy,
        requestedAt: now().toISOString(),
        items: structuredClone(scopedItems(pending, scope)),
      }
      store.runNowRuns = [...store.runNowRuns, run]
      return simulatedSummary(run)
    },

    async getMorningReport(runId) {
      const simulated = store.runNowRuns.find((run) => run.id === runId)
      if (simulated) {
        return simulatedReport(simulated)
      }
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
      const alreadyQueued = pendingItems().some((item) => item.kind === 'rerun' && item.exploitId === exploitId)
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

    // The demo store keeps only the value; Postgres also records updated_by.
    async planTonight() {
      const base = store.replanned ?? seed.scheduledPlan
      store.replanned = {
        scheduledFor: store.replanned?.scheduledFor ?? (base ? shift(base.scheduledFor, createdOffset) : now().toISOString()),
        plan: simulatePlan(base?.plan, pendingItems(), store.budgetUsd, now()),
      }
      return queue()
    },

    async updateNightlyBudget(value) {
      store.budgetUsd = parseNightlyBudget(value)
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

    async listAgentEvents(limit) {
      // Shifted at read time, like run history, so a long-running demo server stays current.
      const offset = dayOffsetMs(now())
      return [...store.events]
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
        .slice(0, limit)
        .map((event) => ({ ...event, createdAt: shift(event.createdAt, offset) }))
    },

    async listNeedsReview() {
      return structuredClone(store.reviews).sort((a, b) => Date.parse(a.flaggedAt) - Date.parse(b.flaggedAt))
    },

    async resolveReview(verdictId, input, reviewer) {
      const review = store.reviews.find((item) => item.verdictId === verdictId)
      if (!review) {
        throw new Error(
          store.resolved.has(verdictId) ? `Verdict ${verdictId} is already resolved` : `Unknown verdict ${verdictId}`,
        )
      }
      const outcome = resolvedOutcome(review.outcome, input)
      store.reviews = store.reviews.filter((item) => item.verdictId !== verdictId)
      store.resolved.add(verdictId)
      store.reviewHistory = [...store.reviewHistory, { category: review.category, judged: review.outcome, human: outcome }]
      store.groundTruthLabels += 1
      // The human verdict is now the family's latest, as the Postgres ticket read derives it.
      const { exploitId } = review
      if (exploitId) {
        store.tickets = store.tickets.map((ticket) => {
          if (ticket.id !== exploitId) {
            return ticket
          }
          const confidence = outcome === 'success' ? 1 : ticket.confidence
          return { ...ticket, lastVerdict: outcome, confidence }
        })
      }
      return { verdictId, decision: input.decision, outcome, reviewer, resolvedAt: now().toISOString() }
    },

    async getJudgeHealth() {
      return summarizeJudgeHealth(store.reviews, store.reviewHistory, store.groundTruthLabels)
    },

    async getResilienceTrend() {
      return structuredClone(fixtures.resilience)
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
