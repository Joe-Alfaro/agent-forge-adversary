import { queryOptions, useQuery, useSuspenseQuery } from '@tanstack/react-query'

import { ACTIVITY_REFRESH_MS } from './activity.js'
import { isRunNowActive } from './run-now.js'
import {
  fetchAgentEvents,
  fetchApprovals,
  fetchCost,
  fetchCoverage,
  fetchDataSourceMode,
  fetchJudgeHealth,
  fetchMorningReport,
  fetchNeedsReview,
  fetchQueue,
  fetchResilienceTrend,
  fetchRun,
  fetchRuns,
  fetchTicket,
  fetchTickets,
} from './data-source.js'

export const dataSourceModeQuery = queryOptions({
  queryKey: ['data-source-mode'],
  queryFn: fetchDataSourceMode,
  staleTime: Number.POSITIVE_INFINITY,
})

// Detail keys nest under their list key so invalidating ['tickets'] refreshes both.
export const ticketsQuery = queryOptions({
  queryKey: ['tickets'],
  queryFn: fetchTickets,
})

export function ticketQuery(id: string) {
  return queryOptions({
    queryKey: ['tickets', id],
    queryFn: () => fetchTicket(id),
  })
}

export const queueQuery = queryOptions({
  queryKey: ['queue'],
  queryFn: fetchQueue,
})

export const runsQuery = queryOptions({
  queryKey: ['runs'],
  queryFn: fetchRuns,
})

/** Polls a run while the executor has it scheduled or running, then stops. */
export function runStatusQuery(runId: string, pollMs: number) {
  return queryOptions({
    queryKey: ['runs', runId, 'status'],
    queryFn: () => fetchRun(runId),
    refetchInterval: (query) => {
      const run = query.state.data
      return run && !isRunNowActive(run.status) ? false : pollMs
    },
  })
}

export function morningReportQuery(runId: string) {
  return queryOptions({
    queryKey: ['runs', runId, 'report'],
    queryFn: () => fetchMorningReport(runId),
  })
}

export const coverageQuery = queryOptions({
  queryKey: ['coverage'],
  queryFn: fetchCoverage,
})

export const costQuery = queryOptions({
  queryKey: ['cost'],
  queryFn: fetchCost,
})

export const approvalsQuery = queryOptions({
  queryKey: ['approvals'],
  queryFn: fetchApprovals,
})

export const agentEventsQuery = queryOptions({
  queryKey: ['agent-events'],
  queryFn: fetchAgentEvents,
  refetchInterval: ACTIVITY_REFRESH_MS,
})

// Both Judge keys nest under ['judge'] so a resolution refreshes the queue and the health numbers together.
export const needsReviewQuery = queryOptions({
  queryKey: ['judge', 'needs-review'],
  queryFn: fetchNeedsReview,
})

export const judgeHealthQuery = queryOptions({
  queryKey: ['judge', 'health'],
  queryFn: fetchJudgeHealth,
})

export const resilienceQuery = queryOptions({
  queryKey: ['resilience'],
  queryFn: fetchResilienceTrend,
})

export function useTickets() {
  return useSuspenseQuery(ticketsQuery)
}

export function useTicket(id: string) {
  return useSuspenseQuery(ticketQuery(id))
}

export function useQueue() {
  return useSuspenseQuery(queueQuery)
}

/** Non-suspending queue read for widgets embedded in other pages. */
export function useQueuePeek() {
  return useQuery(queueQuery)
}

export function useRuns() {
  return useSuspenseQuery(runsQuery)
}

export function useMorningReport(runId: string) {
  return useSuspenseQuery(morningReportQuery(runId))
}

export function useCoverage() {
  return useSuspenseQuery(coverageQuery)
}

export function useCost() {
  return useSuspenseQuery(costQuery)
}

export function useApprovals() {
  return useSuspenseQuery(approvalsQuery)
}

export function useResilienceTrend() {
  return useSuspenseQuery(resilienceQuery)
}

export function useAgentEvents() {
  return useSuspenseQuery(agentEventsQuery)
}

export function useNeedsReview() {
  return useSuspenseQuery(needsReviewQuery)
}

export function useJudgeHealth() {
  return useSuspenseQuery(judgeHealthQuery)
}

/** Non-suspending, so the status line can sit inside the queue page. */
export function useRunStatus(runId: string, pollMs: number) {
  return useQuery(runStatusQuery(runId, pollMs))
}
