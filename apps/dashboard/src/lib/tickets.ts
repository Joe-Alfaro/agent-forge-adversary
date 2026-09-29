import type { AttackCategory, VerdictOutcome } from '@agentforge/contracts'

export type ExploitStatus =
  | 'open'
  | 'in_progress'
  | 'fixed'
  | 'verified'
  | 'false_positive'
  | 'accepted_risk'
  | 'regressed'

export type Severity = 'critical' | 'high' | 'medium' | 'low'

/** An operator's edit to a ticket's workflow fields. */
export interface TicketUpdate {
  status: ExploitStatus
  /** A blank name clears the assignee. */
  assignee: string
}

export interface TicketRow {
  id: string
  severity: Severity
  category: AttackCategory
  owaspIds: string[]
  status: ExploitStatus
  assignee?: string
  confidence: number
  familySize: number
  lastVerdict?: VerdictOutcome
  discoveredVersion: string
  lastVerifiedVersion?: string
}

const SEVERITY_ORDER: Record<Severity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
}

/** Default triage order for the ticket tracker: severity first, then open before resolved. */
export function sortForTriage(rows: readonly TicketRow[]): TicketRow[] {
  const openish = new Set<ExploitStatus>(['open', 'in_progress', 'regressed'])
  return [...rows].sort((a, b) => {
    const aOpen = openish.has(a.status) ? 0 : 1
    const bOpen = openish.has(b.status) ? 0 : 1
    if (aOpen !== bOpen) {
      return aOpen - bOpen
    }
    return SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]
  })
}

/** A ticket can be queued for tonight only when it is not already resolved. */
export function canRecheckTonight(status: ExploitStatus): boolean {
  return status !== 'verified' && status !== 'false_positive' && status !== 'accepted_risk'
}

/**
 * Operator status workflow from ARCHITECTURE.md Section 15.1: open → in_progress →
 * fixed → verified, with false_positive and accepted_risk as dismissals and
 * regressed when a verified fix stops holding.
 */
const TRANSITIONS: Record<ExploitStatus, ExploitStatus[]> = {
  open: ['in_progress', 'false_positive', 'accepted_risk'],
  in_progress: ['fixed', 'open', 'false_positive', 'accepted_risk'],
  fixed: ['verified', 'regressed', 'in_progress'],
  verified: ['regressed'],
  regressed: ['in_progress', 'fixed', 'accepted_risk'],
  false_positive: ['open'],
  accepted_risk: ['open'],
}

/** Statuses an operator may move a ticket to from `status`. */
export function nextStatuses(status: ExploitStatus): ExploitStatus[] {
  return [...TRANSITIONS[status]]
}

const STATUSES = Object.keys(TRANSITIONS)
const SEVERITIES = Object.keys(SEVERITY_ORDER)

export function isExploitStatus(value: unknown): value is ExploitStatus {
  return typeof value === 'string' && STATUSES.includes(value)
}

export function isSeverity(value: unknown): value is Severity {
  return typeof value === 'string' && SEVERITIES.includes(value)
}
