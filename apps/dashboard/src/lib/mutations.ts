import type { RerunRequest } from '@agentforge/contracts'
import { useMutation, useQueryClient } from '@tanstack/react-query'

import type { ApprovalDecision } from './approvals.js'
import type { ReviewInput } from './judge.js'
import type { RunNowScope } from './run-now.js'
import {
  decideApproval,
  enqueueRerun,
  moveQueueItem,
  planTonight,
  removeQueueItem,
  resolveReview,
  runNow,
  updateNightlyBudget,
  type TicketUpdate,
  updateTicket,
} from './data-source.js'
import type { MoveDirection } from './queue.js'
import { approvalsQuery, queueQuery, resilienceQuery, runsQuery, ticketsQuery } from './queries.js'

export interface TicketUpdateVariables {
  id: string
  update: TicketUpdate
}

export function useUpdateTicket() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, update }: TicketUpdateVariables) => updateTicket(id, update),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ticketsQuery.queryKey }),
  })
}

export function useEnqueueRerun() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (request: RerunRequest) => enqueueRerun(request),
    onSuccess: (queue) => queryClient.setQueryData(queueQuery.queryKey, queue),
  })
}

export function useRemoveQueueItem() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => removeQueueItem(id),
    onSuccess: (queue) => queryClient.setQueryData(queueQuery.queryKey, queue),
  })
}

export interface MoveVariables {
  id: string
  direction: MoveDirection
}

export function useMoveQueueItem() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, direction }: MoveVariables) => moveQueueItem(id, direction),
    onSuccess: (queue) => queryClient.setQueryData(queueQuery.queryKey, queue),
  })
}

export interface ApprovalVariables {
  reportId: string
  decision: ApprovalDecision
}

export function useDecideApproval() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ reportId, decision }: ApprovalVariables) => decideApproval(reportId, decision),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: approvalsQuery.queryKey }),
  })
}

export interface ReviewVariables {
  verdictId: string
  review: ReviewInput
}

/** A human verdict changes the review queue, Judge health, M4, and a ticket's last verdict. */
export function useResolveReview() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ verdictId, review }: ReviewVariables) => resolveReview(verdictId, review),
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: ['judge'] }),
        queryClient.invalidateQueries({ queryKey: resilienceQuery.queryKey }),
        queryClient.invalidateQueries({ queryKey: ticketsQuery.queryKey }),
      ]),
  })
}

/** Schedules a run-now; the run history and queue refresh as the executor picks it up. */
export function useRunNow() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (scope: RunNowScope) => runNow(scope),
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: runsQuery.queryKey }),
        queryClient.invalidateQueries({ queryKey: queueQuery.queryKey }),
      ]),
  })
}

/** Saves the nightly budget; the queue comes back with the new envelope. */
export function useUpdateNightlyBudget() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (budgetUsd: number) => updateNightlyBudget(budgetUsd),
    onSuccess: (queue) => queryClient.setQueryData(queueQuery.queryKey, queue),
  })
}

/** "Plan tonight now": shows the regenerated plan at once, then refetches the queue. */
export function usePlanTonight() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => planTonight(),
    onSuccess: async (queue) => {
      queryClient.setQueryData(queueQuery.queryKey, queue)
      await queryClient.invalidateQueries({ queryKey: queueQuery.queryKey })
    },
  })
}
