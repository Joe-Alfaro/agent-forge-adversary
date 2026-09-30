import { type RerunRequest, validateRerunRequest } from '@agentforge/contracts'

import { type ApprovalDecision, decisionStatus, nextReportStatuses, type ReportStatus } from '../lib/approvals.js'
import { type RunNowScope, scopedItems } from '../lib/run-now.js'
import { canRecheckTonight, type ExploitStatus, nextStatuses } from '../lib/tickets.js'

/** Shared write rules, so both repositories reject exactly the same requests. */

export function assertTransition(from: ExploitStatus, to: ExploitStatus): void {
  if (from !== to && !nextStatuses(from).includes(to)) {
    throw new Error(`Status change ${from} → ${to} is not allowed`)
  }
}

/** Validates against RerunRequest v1 and returns the exploit it targets. */
export function assertRerunRequest(request: unknown): { request: RerunRequest; exploitId: string } {
  const result = validateRerunRequest(request)
  if (!result.valid || !result.value) {
    throw new Error(`Invalid RerunRequest: ${result.errors.join('; ')}`)
  }
  const exploitId = result.value.target.exploit_id
  if (result.value.target.kind !== 'exploit' || !exploitId) {
    throw new Error('Only exploit re-checks can be queued from the dashboard')
  }
  return { request: result.value, exploitId }
}

export function assertCanRecheck(exploitId: string, status: ExploitStatus, alreadyQueued: boolean): void {
  if (!canRecheckTonight(status)) {
    throw new Error(`${exploitId} is ${status} and cannot be re-checked`)
  }
  if (alreadyQueued) {
    throw new Error(`${exploitId} is already queued for tonight`)
  }
}

export function normalizeAssignee(assignee: string): string | undefined {
  const trimmed = assignee.trim()
  return trimmed === '' ? undefined : trimmed
}

/** Returns the status an approval decision moves a report to, or throws when the workflow forbids it. */
export function assertReportDecision(from: ReportStatus, decision: ApprovalDecision): ReportStatus {
  const to = decisionStatus(decision)
  if (!nextReportStatuses(from).includes(to)) {
    throw new Error(`Report status change ${from} → ${to} is not allowed`)
  }
  return to
}

/** Gate G10 checks before a run-now row is written: one at a time, and only for queued work. */
export function assertRunNow(queuedIds: readonly { id: string }[], scope: RunNowScope, alreadyActive: boolean): void {
  if (alreadyActive) {
    throw new Error('A run-now is already scheduled or running; wait for it to finish')
  }
  if (scope.kind === 'single' && scopedItems(queuedIds, scope).length === 0) {
    throw new Error(`Request ${scope.operatorRequestId} is not in tonight’s queue`)
  }
  if (queuedIds.length === 0) {
    throw new Error('Nothing is queued for tonight')
  }
}
