import type { RerunRequest } from '@agentforge/contracts'
import { useMutation, useQueryClient } from '@tanstack/react-query'

import {
  enqueueRerun,
  moveQueueItem,
  removeQueueItem,
  type TicketUpdate,
  updateTicket,
} from './data-source.js'
import type { MoveDirection } from './queue.js'
import { queueQuery, ticketsQuery } from './queries.js'

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
