import { createServerFn } from '@tanstack/react-start'

import { operatorName } from '../server/config.js'
import { getRepository, getRuntime } from '../server/runtime.js'
import { ACTIVITY_LIMIT } from './activity.js'
import { isApprovalDecision } from './approvals.js'
import { parseNightlyBudget } from './budget.js'
import { parseRunNowScope } from './run-now.js'
import { isReviewDecision, isVerdictOutcome, type ReviewInput } from './judge.js'
import type { MoveDirection } from './queue.js'
import { isExploitStatus } from './tickets.js'

/*
 * RPC boundary between the browser and the repository. Validators run on the
 * server and narrow untrusted input; RerunRequest bodies are checked against
 * the v1 contract inside the repository.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new Error(`${name} must be a non-empty string`)
  }
  return value
}

export const getDataSourceModeFn = createServerFn({ method: 'GET' }).handler(() => getRuntime().mode)

export const listTicketsFn = createServerFn({ method: 'GET' }).handler(() => getRepository().listTickets())

export const getTicketFn = createServerFn({ method: 'GET' })
  .validator((id: unknown) => requireString(id, 'Ticket id'))
  .handler(({ data }) => getRepository().getTicket(data))

export const updateTicketFn = createServerFn({ method: 'POST' })
  .validator((input: unknown) => {
    if (!isRecord(input) || !isRecord(input.update)) {
      throw new Error('Expected { id, update }')
    }
    const { status, assignee } = input.update
    if (!isExploitStatus(status)) {
      throw new Error('Unknown status')
    }
    if (typeof assignee !== 'string') {
      throw new Error('Assignee must be a string')
    }
    return { id: requireString(input.id, 'Ticket id'), update: { status, assignee } }
  })
  .handler(({ data }) => getRepository().updateTicket(data.id, data.update))

export const listRunsFn = createServerFn({ method: 'GET' }).handler(() => getRepository().listRuns())

export const getRunFn = createServerFn({ method: 'GET' })
  .validator((runId: unknown) => requireString(runId, 'Run id'))
  .handler(({ data }) => getRepository().getRun(data))

/** Gate G10, after the operator confirmed the estimate: schedules the run, never executes it. */
export const runNowFn = createServerFn({ method: 'POST' })
  .validator((scope: unknown) => parseRunNowScope(scope))
  .handler(({ data }) => getRepository().runNow(data, operatorName(process.env)))

export const getMorningReportFn = createServerFn({ method: 'GET' })
  .validator((runId: unknown) => requireString(runId, 'Run id'))
  .handler(({ data }) => getRepository().getMorningReport(data))

export const getCoverageFn = createServerFn({ method: 'GET' }).handler(() => getRepository().getCoverage())

export const getCostFn = createServerFn({ method: 'GET' }).handler(() => getRepository().getCost())

export const getQueueFn = createServerFn({ method: 'GET' }).handler(() => getRepository().getQueue())

export const enqueueRerunFn = createServerFn({ method: 'POST' })
  .validator((request: unknown) => request)
  .handler(({ data }) => getRepository().enqueueRerun(data))

/** Regenerates tonight's plan through the Orchestrator's planner (no attacks, no spend). */
export const planTonightFn = createServerFn({ method: 'POST' }).handler(() =>
  getRepository().planTonight(operatorName(process.env)),
)

/** Gate G3 (raise a budget envelope) is the operator's; validated here and again in the repository. */
export const updateNightlyBudgetFn = createServerFn({ method: 'POST' })
  .validator((value: unknown) => parseNightlyBudget(value))
  // Recorded as updated_by under the login's username, never taken from the browser.
  .handler(({ data }) => getRepository().updateNightlyBudget(data, operatorName(process.env)))

export const removeQueueItemFn = createServerFn({ method: 'POST' })
  .validator((id: unknown) => requireString(id, 'Request id'))
  .handler(({ data }) => getRepository().removeQueueItem(data))

export const moveQueueItemFn = createServerFn({ method: 'POST' })
  .validator((input: unknown) => {
    if (!isRecord(input) || (input.direction !== 'up' && input.direction !== 'down')) {
      throw new Error('Expected { id, direction: "up" | "down" }')
    }
    const direction: MoveDirection = input.direction
    return { id: requireString(input.id, 'Request id'), direction }
  })
  .handler(({ data }) => getRepository().moveQueueItem(data.id, data.direction))

export const listAgentEventsFn = createServerFn({ method: 'GET' }).handler(() =>
  getRepository().listAgentEvents(ACTIVITY_LIMIT),
)

export const getResilienceTrendFn = createServerFn({ method: 'GET' }).handler(() =>
  getRepository().getResilienceTrend(),
)

export const listApprovalsFn = createServerFn({ method: 'GET' }).handler(() => getRepository().listApprovals())

export const decideApprovalFn = createServerFn({ method: 'POST' })
  .validator((input: unknown) => {
    if (!isRecord(input) || !isApprovalDecision(input.decision)) {
      throw new Error('Expected { reportId, decision: "approve" | "reject" }')
    }
    return { reportId: requireString(input.reportId, 'Report id'), decision: input.decision }
  })
  // The reviewer is set on the server, never taken from the browser.
  .handler(({ data }) =>
    getRepository().decideApproval(data.reportId, data.decision, operatorName(process.env)),
  )

export const listNeedsReviewFn = createServerFn({ method: 'GET' }).handler(() => getRepository().listNeedsReview())

export const getJudgeHealthFn = createServerFn({ method: 'GET' }).handler(() => getRepository().getJudgeHealth())

export const resolveReviewFn = createServerFn({ method: 'POST' })
  .validator((input: unknown) => {
    if (!isRecord(input) || !isReviewDecision(input.decision)) {
      throw new Error('Expected { verdictId, decision: "confirm" | "overturn", outcome? }')
    }
    if (input.outcome !== undefined && !isVerdictOutcome(input.outcome)) {
      throw new Error('Unknown outcome')
    }
    const review: ReviewInput =
      input.outcome === undefined ? { decision: input.decision } : { decision: input.decision, outcome: input.outcome }
    return { verdictId: requireString(input.verdictId, 'Verdict id'), review }
  })
  // The reviewer is set on the server, never taken from the browser.
  .handler(({ data }) => getRepository().resolveReview(data.verdictId, data.review, operatorName(process.env)))
