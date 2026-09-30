import {
  ATTACK_TAXONOMY,
  type Evidence,
  type AttackCategory,
  type AttackSubcategory,
  isAttackCategory,
  type NightlyRunSummary,
  validateNightlyRunSummary,
  type VerdictOutcome,
} from '@agentforge/contracts'

import { type AgentEvent, eventSummary, payloadTraceUrl } from '../lib/activity.js'
import { type ApprovalItem, buildApprovalItem, isReportStatus } from '../lib/approvals.js'
import { type ReviewItem, transcriptExcerpt } from '../lib/judge.js'
import type {
  CoverageCell,
  MorningReport,
  QueueItem,
  QueueItemKind,
  RunStatus,
  RunSummary,
  RunTrigger,
} from '../lib/models.js'
import { estimateRerunCostUsd } from '../lib/queue.js'
import { isExploitStatus, isSeverity, type TicketRow } from '../lib/tickets.js'

/*
 * Row → read model conversion for the Postgres repository. Rows arrive as
 * `unknown`: pg returns numerics and counts as strings and timestamps as Dates,
 * and jsonb is whatever an upstream agent wrote, so everything is narrowed here.
 */

type Row = Record<string, unknown>

function isRecord(value: unknown): value is Row {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function field(row: unknown, key: string): unknown {
  if (!isRecord(row)) {
    throw new Error('Expected a database row')
  }
  return row[key]
}

function text(row: unknown, key: string): string {
  const value = field(row, key)
  if (typeof value === 'string') {
    return value
  }
  if (typeof value === 'number') {
    return String(value)
  }
  throw new Error(`Column ${key} must be text, got ${typeof value}`)
}

function optionalText(row: unknown, key: string): string | undefined {
  const value = field(row, key)
  if (value === null || value === undefined) {
    return undefined
  }
  return text(row, key)
}

function num(row: unknown, key: string): number {
  const value = field(row, key)
  if (value === null || value === undefined) {
    return 0
  }
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed)) {
    throw new Error(`Column ${key} must be numeric, got ${String(value)}`)
  }
  return parsed
}

function iso(row: unknown, key: string): string {
  const value = field(row, key)
  if (value instanceof Date) {
    return value.toISOString()
  }
  if (typeof value === 'string') {
    return new Date(value).toISOString()
  }
  throw new Error(`Column ${key} must be a timestamp`)
}

function optionalIso(row: unknown, key: string): string | undefined {
  const value = field(row, key)
  if (value === null || value === undefined) {
    return undefined
  }
  return iso(row, key)
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }
  return value.filter((item): item is string => typeof item === 'string')
}

const VERDICT_OUTCOMES: readonly string[] = ['success', 'partial', 'fail']

function isVerdictOutcome(value: unknown): value is VerdictOutcome {
  return typeof value === 'string' && VERDICT_OUTCOMES.includes(value)
}

/** Adds `key` only when `value` is defined, as exactOptionalPropertyTypes requires. */
function withOptional<T extends object, K extends string, V>(target: T, key: K, value: V | undefined) {
  if (value === undefined) {
    return target
  }
  return { ...target, [key]: value }
}

function attackCategory(value: unknown): AttackCategory | undefined {
  return typeof value === 'string' && isAttackCategory(value) ? value : undefined
}

function attackSubcategory(category: AttackCategory, value: unknown): AttackSubcategory | undefined {
  const allowed: readonly AttackSubcategory[] = ATTACK_TAXONOMY[category]
  return allowed.find((subcategory) => subcategory === value)
}

/** One coverage row, or null when its cell is outside AttackTaxonomy v1. */
export function mapCoverageRow(row: unknown): CoverageCell | null {
  const category = attackCategory(field(row, 'category'))
  if (!category) {
    return null
  }
  const subcategory = attackSubcategory(category, field(row, 'subcategory'))
  if (!subcategory) {
    return null
  }
  const cell: CoverageCell = {
    category,
    subcategory,
    owaspIds: stringArray(field(row, 'owasp_ids')).sort(),
    attempts: num(row, 'attempts'),
    confirmed: num(row, 'confirmed'),
  }
  const families = field(row, 'families_exercised')
  const withFamilies = withOptional(cell, 'familiesExercised', families === null || families === undefined ? undefined : num(row, 'families_exercised'))
  return withOptional(withFamilies, 'lastRunAt', optionalIso(row, 'last_run_at'))
}

export function mapTicket(row: unknown): TicketRow {
  const id = text(row, 'id')
  const severity = field(row, 'severity')
  const status = field(row, 'status')
  if (!isSeverity(severity)) {
    throw new Error(`Ticket ${id} has an unknown severity "${String(severity)}"`)
  }
  if (!isExploitStatus(status)) {
    throw new Error(`Ticket ${id} has an unknown status "${String(status)}"`)
  }
  const category = attackCategory(field(row, 'category'))
  if (!category) {
    throw new Error(`Ticket ${id} has category "${String(field(row, 'category'))}", which is not in AttackTaxonomy v1`)
  }
  const lastVerdict = field(row, 'last_verdict')
  const base: TicketRow = {
    id,
    severity,
    category,
    owaspIds: stringArray(field(row, 'owasp_ids')),
    status,
    confidence: num(row, 'max_confidence'),
    familySize: num(row, 'family_size'),
    discoveredVersion: optionalText(row, 'discovered_version') ?? 'unknown',
  }
  const withAssignee = withOptional(base, 'assignee', optionalText(row, 'assignee'))
  const withVerdict = withOptional(withAssignee, 'lastVerdict', isVerdictOutcome(lastVerdict) ? lastVerdict : undefined)
  return withOptional(withVerdict, 'lastVerifiedVersion', optionalText(row, 'last_verified_version'))
}

/**
 * `nightly_runs.summary` is NightlyRunSummary v1. A summary that fails the
 * contract is treated as missing (derived counts, no morning report) rather than
 * trusted, and logged so the writer can be fixed.
 */
function readSummary(row: unknown): NightlyRunSummary | null {
  const value = field(row, 'summary')
  if (value === null || value === undefined) {
    return null
  }
  const result = validateNightlyRunSummary(value)
  if (!result.valid || !result.value) {
    console.warn(`nightly_runs ${String(field(row, 'id'))}: summary fails NightlyRunSummary v1: ${result.errors.join('; ')}`)
    return null
  }
  return result.value
}

const RUN_STATUSES: readonly RunStatus[] = ['scheduled', 'running', 'completed', 'failed', 'aborted']

function runStatus(value: unknown): RunStatus {
  return RUN_STATUSES.find((status) => status === value) ?? 'failed'
}

function runTrigger(value: unknown): RunTrigger {
  return value === 'run_now' ? 'run_now' : 'cron'
}

function hasReport(row: unknown, summary: NightlyRunSummary | null): summary is NightlyRunSummary {
  return summary !== null && field(row, 'status') === 'completed'
}

export function mapRunSummary(row: unknown): RunSummary {
  const summary = readSummary(row)
  const base: RunSummary = {
    id: text(row, 'id'),
    trigger: runTrigger(field(row, 'trigger')),
    status: runStatus(field(row, 'status')),
    startedAt: iso(row, 'started_at'),
    targetVersion: summary?.target_version ?? optionalText(row, 'target_version') ?? 'unknown',
    attempts: num(row, 'attempts'),
    verdicts: { success: num(row, 'success'), partial: num(row, 'partial'), fail: num(row, 'fail') },
    newTickets: summary ? summary.new_tickets.length : num(row, 'new_tickets_by_time'),
    regressions: summary?.regressions.length ?? 0,
    spendUsd: num(row, 'spend_usd'),
    hasMorningReport: hasReport(row, summary),
  }
  const withFinish = withOptional(base, 'finishedAt', optionalIso(row, 'finished_at'))
  return withOptional(withFinish, 'traceUrl', summary?.trace_url)
}

export function mapMorningReport(row: unknown): MorningReport | null {
  const summary = readSummary(row)
  if (!hasReport(row, summary)) {
    return null
  }
  const run = mapRunSummary(row)
  return {
    runId: run.id,
    targetVersion: summary.target_version,
    generatedAt: summary.generated_at,
    headline: summary.headline,
    attempts: run.attempts,
    verdicts: run.verdicts,
    spendUsd: run.spendUsd,
    newTickets: summary.new_tickets,
    regressions: summary.regressions,
    verifiedFixes: summary.verified_fixes,
    queue: { ran: summary.queue.ran, cut: summary.queue.cut },
    notes: summary.notes,
  }
}

const QUEUE_KINDS: readonly QueueItemKind[] = ['rerun', 'focus', 'skip', 'note']

/**
 * A stored estimate wins. Otherwise reruns are estimated from the family size;
 * campaign-sized requests (focus, skip, note) are budgeted by the Orchestrator.
 */
function estimateFor(kind: QueueItemKind, stored: unknown, familySize: unknown, row: unknown): number {
  if (stored !== null && stored !== undefined) {
    return num(row, 'estimated_cost_usd')
  }
  if (kind === 'rerun' && familySize !== null && familySize !== undefined) {
    return estimateRerunCostUsd(num(row, 'family_size'))
  }
  return 0
}

export function mapQueueItem(row: unknown): QueueItem {
  const id = text(row, 'id')
  const kind = QUEUE_KINDS.find((candidate) => candidate === field(row, 'kind'))
  if (!kind) {
    throw new Error(`Queue item ${id} has an unknown kind`)
  }
  const familySize = field(row, 'family_size')
  const stored = field(row, 'estimated_cost_usd')
  const base: QueueItem = {
    id,
    kind,
    requestedBy: text(row, 'requested_by'),
    requestedAt: iso(row, 'created_at'),
    source: field(row, 'source') === 'chat' ? 'chat' : 'ui',
    estimatedCostUsd: estimateFor(kind, stored, familySize, row),
  }
  const withExploit = withOptional(base, 'exploitId', optionalText(row, 'exploit_id'))
  const rawCategory = optionalText(row, 'category')
  const category = attackCategory(rawCategory)
  if (rawCategory !== undefined && !category) {
    throw new Error(`Queue item ${id} has category "${rawCategory}", which is not in AttackTaxonomy v1`)
  }
  const withCategory = withOptional(withExploit, 'category', category)
  return withOptional(withCategory, 'reason', optionalText(row, 'reason'))
}

/** One `reports` row joined to its exploit; the title comes from the VulnReport body when it has one. */
export function mapApprovalRow(row: unknown): ApprovalItem {
  const reportId = text(row, 'id')
  const status = field(row, 'status')
  const severity = field(row, 'severity')
  if (!isReportStatus(status)) {
    throw new Error(`Report ${reportId} has an unknown status "${String(status)}"`)
  }
  if (!isSeverity(severity)) {
    throw new Error(`Report ${reportId} has an unknown severity "${String(severity)}"`)
  }
  const category = attackCategory(field(row, 'category'))
  if (!category) {
    throw new Error(`Report ${reportId} has category "${String(field(row, 'category'))}", which is not in AttackTaxonomy v1`)
  }
  const exploitId = text(row, 'exploit_id')
  const version = num(row, 'version')
  const base = {
    reportId,
    exploitId,
    version,
    severity,
    category,
    title: optionalText(row, 'title') || `${exploitId} report v${version}`,
    status,
    draftedAt: iso(row, 'created_at'),
  }
  const withApprover = withOptional(base, 'approvedBy', optionalText(row, 'approved_by'))
  return buildApprovalItem(withOptional(withApprover, 'publishedAt', optionalIso(row, 'published_at')))
}

/** One `agent_events` row; the trace link and summary are read defensively from the free-form payload. */
export function mapAgentEvent(row: unknown): AgentEvent {
  const payload = field(row, 'payload')
  const base: AgentEvent = {
    id: text(row, 'id'),
    traceId: text(row, 'trace_id'),
    agent: text(row, 'agent'),
    eventType: text(row, 'event_type'),
    costUsd: num(row, 'cost_usd'),
    createdAt: iso(row, 'created_at'),
  }
  const withSource = withOptional(base, 'source', optionalText(row, 'source'))
  const withTrace = withOptional(withSource, 'traceUrl', payloadTraceUrl(payload))
  return withOptional(withTrace, 'summary', eventSummary(payload))
}

const EVIDENCE_KINDS: readonly string[] = ['detector_hit', 'quoted_span', 'tool_call']

function evidenceItem(value: unknown): Evidence | undefined {
  if (!isRecord(value) || typeof value.ref !== 'string') {
    return undefined
  }
  const kind = EVIDENCE_KINDS.find((candidate) => candidate === value.kind)
  if (kind !== 'detector_hit' && kind !== 'quoted_span' && kind !== 'tool_call') {
    return undefined
  }
  const item: Evidence = { kind, ref: value.ref }
  return typeof value.note === 'string' ? { ...item, note: value.note } : item
}

/** A flagged verdict with its attempt; malformed evidence entries are skipped rather than failing the queue. */
export function mapReviewItem(row: unknown): ReviewItem {
  const verdictId = text(row, 'id')
  const outcome = field(row, 'outcome')
  if (!isVerdictOutcome(outcome)) {
    throw new Error(`Verdict ${verdictId} has an unknown outcome "${String(outcome)}"`)
  }
  const evidenceValue = field(row, 'evidence')
  const evidence = (Array.isArray(evidenceValue) ? evidenceValue : [])
    .map(evidenceItem)
    .filter((item): item is Evidence => item !== undefined)
  const base: ReviewItem = {
    verdictId,
    attemptId: text(row, 'attempt_id'),
    category: text(row, 'category'),
    outcome,
    confidence: num(row, 'confidence'),
    stage: text(row, 'stage'),
    rubricVersion: text(row, 'rubric_version'),
    flaggedAt: iso(row, 'created_at'),
    evidence,
  }
  const withSub = withOptional(base, 'subcategory', optionalText(row, 'subcategory'))
  const withVersion = withOptional(withSub, 'targetVersion', optionalText(row, 'target_version'))
  const withModel = withOptional(withVersion, 'judgeModel', optionalText(row, 'judge_model'))
  return withOptional(withModel, 'excerpt', transcriptExcerpt(field(row, 'transcript')))
}
