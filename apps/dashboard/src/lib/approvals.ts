import type { AttackCategory } from '@agentforge/contracts'

import type { Severity } from './tickets.js'

/**
 * `reports.status`. The Documentation Agent writes drafts only (Section 14.4);
 * an operator decision moves a draft to published or rejected, and a published
 * report found to be wrong is withdrawn as a false positive (Section 10).
 */
export type ReportStatus = 'draft' | 'published' | 'rejected' | 'false_positive'

export type ApprovalDecision = 'approve' | 'reject'

/** Section 10: G4 needs an operator; G5 publishes itself after the review window. */
export type ApprovalGate = 'G4' | 'G5'

/** A report draft waiting at a human gate before publish. */
export interface ApprovalItem {
  reportId: string
  exploitId: string
  version: number
  severity: Severity
  category: AttackCategory
  title: string
  status: ReportStatus
  draftedAt: string
  gate: ApprovalGate
  /** G5 only: when the draft publishes without a decision. */
  autoPublishAt?: string
  /** Set once decided: the operator who approved or rejected (reports.approved_by). */
  approvedBy?: string
  publishedAt?: string
}

/** One `reports` row as the fixture store holds it; severity and category come from the exploit. */
export interface ReportRecord {
  id: string
  exploitId: string
  version: number
  status: ReportStatus
  title: string
  createdAt: string
  approvedBy?: string
  publishedAt?: string
}

export const REVIEW_WINDOW_HOURS = 24

const TRANSITIONS: Record<ReportStatus, ReportStatus[]> = {
  draft: ['published', 'rejected'],
  published: ['false_positive'],
  rejected: [],
  false_positive: [],
}

const DECISION_STATUS: Record<ApprovalDecision, ReportStatus> = {
  approve: 'published',
  reject: 'rejected',
}

export function approvalGate(severity: Severity): ApprovalGate {
  return severity === 'critical' || severity === 'high' ? 'G4' : 'G5'
}

export function nextReportStatuses(status: ReportStatus): ReportStatus[] {
  return [...TRANSITIONS[status]]
}

export function decisionStatus(decision: ApprovalDecision): ReportStatus {
  return DECISION_STATUS[decision]
}

/** The approve/reject buttons a report in `status` may show. */
export function allowedDecisions(status: ReportStatus): ApprovalDecision[] {
  const next = TRANSITIONS[status]
  const decisions: ApprovalDecision[] = ['approve', 'reject']
  return decisions.filter((decision) => next.includes(DECISION_STATUS[decision]))
}

export function autoPublishAt(severity: Severity, draftedAt: string): string | undefined {
  if (approvalGate(severity) === 'G4') {
    return undefined
  }
  return new Date(Date.parse(draftedAt) + REVIEW_WINDOW_HOURS * 3_600_000).toISOString()
}

const STATUSES = Object.keys(TRANSITIONS)

export function isReportStatus(value: unknown): value is ReportStatus {
  return typeof value === 'string' && STATUSES.includes(value)
}

export function isApprovalDecision(value: unknown): value is ApprovalDecision {
  return value === 'approve' || value === 'reject'
}

/** G4 first, then oldest draft first, so the longest-waiting high-risk report leads. */
export function sortApprovals(items: readonly ApprovalItem[]): ApprovalItem[] {
  return [...items].sort((a, b) => {
    if (a.gate !== b.gate) {
      return a.gate === 'G4' ? -1 : 1
    }
    return Date.parse(a.draftedAt) - Date.parse(b.draftedAt)
  })
}

export type ApprovalFields = Omit<ApprovalItem, 'gate' | 'autoPublishAt'>

/** Adds the gate, and for undecided G5 drafts the auto-publish time, to a report row. */
export function buildApprovalItem(fields: ApprovalFields): ApprovalItem {
  const item: ApprovalItem = { ...fields, gate: approvalGate(fields.severity) }
  const publishAt = fields.status === 'draft' ? autoPublishAt(fields.severity, fields.draftedAt) : undefined
  return publishAt ? { ...item, autoPublishAt: publishAt } : item
}
