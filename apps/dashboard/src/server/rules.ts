import { type RerunRequest, validateRerunRequest } from '@agentforge/contracts'

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
