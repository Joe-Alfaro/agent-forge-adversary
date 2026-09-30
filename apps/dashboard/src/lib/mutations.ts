import type { RerunRequest } from '@agentforge/contracts'
import { useMutation, useQueryClient } from '@tanstack/react-query'

import type { ApprovalDecision } from './approvals.js'
import type { ReviewInput } from './judge.js'
import {
  decideApproval,
  enqueueRerun,
  moveQueueItem,
  removeQueueItem,
  resolveReview,
  type TicketUpdate,
  updateTicket,
} from './data-source.js'
import type { MoveDirection } from './queue.js'
import { approvalsQuery, queueQuery, resilienceQuery, ticketsQuery } from './queries.js'

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
