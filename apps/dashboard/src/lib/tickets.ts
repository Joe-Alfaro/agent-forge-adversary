import type { VerdictOutcome } from '@agentforge/contracts'

export type ExploitStatus =
  | 'open'
  | 'in_progress'
  | 'fixed'
  | 'verified'
  | 'false_positive'
  | 'accepted_risk'
  | 'regressed'

export type Severity = 'critical' | 'high' | 'medium' | 'low'

export interface TicketRow {
  id: string
  severity: Severity
  category: string
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
