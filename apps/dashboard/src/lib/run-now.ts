import type { QueueItem, RunStatus } from './models.js'

/*
 * Run now (ARCHITECTURE.md Section 10, gate G10): the operator confirms an
 * estimate, then the dashboard inserts one `nightly_runs` row with
 * trigger = 'run_now', status = 'scheduled', and plan = RunNowPlan. The
 * executor owns everything after that; the dashboard never runs attacks.
 */

export type RunNowScope = { kind: 'queue' } | { kind: 'single'; operatorRequestId: string }

/** `nightly_runs.plan` for a run-now row; the executor reads exactly these keys. */
export interface RunNowPlan {
  scope: RunNowScope
  requested_by: string
  requested_at: string
}

export interface RunNowEstimate {
  itemCount: number
  estimatedUsd: number
  envelopeUsd: number
  exceedsEnvelope: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Narrows untrusted input to a scope, keeping only the keys the executor expects. */
export function parseRunNowScope(value: unknown): RunNowScope {
  if (!isRecord(value)) {
    throw new Error('Run-now scope must be { kind: "queue" } or { kind: "single", operatorRequestId }')
  }
  if (value.kind === 'queue') {
    return { kind: 'queue' }
  }
  if (value.kind === 'single') {
    if (typeof value.operatorRequestId !== 'string' || value.operatorRequestId === '') {
      throw new Error('A single run-now needs an operatorRequestId')
    }
    return { kind: 'single', operatorRequestId: value.operatorRequestId }
  }
  throw new Error('Run-now scope must be { kind: "queue" } or { kind: "single", operatorRequestId }')
}

/** The queued requests a run-now would drain, in queue order. */
export function scopedItems<T extends Pick<QueueItem, 'id'>>(items: readonly T[], scope: RunNowScope): T[] {
  if (scope.kind === 'queue') {
    return [...items]
  }
  return items.filter((entry) => entry.id === scope.operatorRequestId)
}

/**
 * The cost shown before confirming. Queue items already carry the stored
 * `estimated_cost_usd`, or the family-size estimate when that is null; for the
 * whole queue, pass the plan's coverage campaigns too, since a run-now plans
 * them alongside the operator requests.
 */
export function estimateRunNow(
  items: readonly Pick<QueueItem, 'id' | 'estimatedCostUsd'>[],
  scope: RunNowScope,
  envelopeUsd: number,
): RunNowEstimate {
  const scoped = scopedItems(items, scope)
  const estimatedUsd = Math.round(scoped.reduce((sum, entry) => sum + entry.estimatedCostUsd, 0) * 100) / 100
  return { itemCount: scoped.length, estimatedUsd, envelopeUsd, exceedsEnvelope: estimatedUsd > envelopeUsd }
}

export function buildRunNowPlan(scope: RunNowScope, requestedBy: string, requestedAt: Date): RunNowPlan {
  return { scope, requested_by: requestedBy, requested_at: requestedAt.toISOString() }
}

/** Scheduled or running: the executor has not finished with it. */
export function isRunNowActive(status: RunStatus): boolean {
  return status === 'scheduled' || status === 'running'
}
