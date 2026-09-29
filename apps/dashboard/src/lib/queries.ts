import { queryOptions, useSuspenseQuery } from '@tanstack/react-query'

import { fetchCost, fetchCoverage, fetchRuns, fetchTickets } from './data-source.js'

export const ticketsQuery = queryOptions({
  queryKey: ['tickets'],
  queryFn: fetchTickets,
})

export const runsQuery = queryOptions({
  queryKey: ['runs'],
  queryFn: fetchRuns,
})

export const coverageQuery = queryOptions({
  queryKey: ['coverage'],
  queryFn: fetchCoverage,
})

export const costQuery = queryOptions({
  queryKey: ['cost'],
  queryFn: fetchCost,
})

export function useTickets() {
  return useSuspenseQuery(ticketsQuery)
}

export function useRuns() {
  return useSuspenseQuery(runsQuery)
}

export function useCoverage() {
  return useSuspenseQuery(coverageQuery)
}

export function useCost() {
  return useSuspenseQuery(costQuery)
}
