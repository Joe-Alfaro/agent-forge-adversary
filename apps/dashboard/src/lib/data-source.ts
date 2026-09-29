import { cost, coverage, runs, tickets } from './fixtures.js'
import type { CostSummary, CoverageMatrix, RunSummary } from './models.js'
import type { TicketRow } from './tickets.js'

/*
 * The dashboard's only data seam. v1 reads synthetic fixtures; swapping to
 * TanStack Start server functions backed by @agentforge/db means replacing
 * these four bodies and nothing else. Copies are returned so callers cannot
 * mutate the fixtures.
 */

export async function fetchTickets(): Promise<TicketRow[]> {
  return tickets.map((ticket) => ({ ...ticket, owaspIds: [...ticket.owaspIds] }))
}

export async function fetchRuns(): Promise<RunSummary[]> {
  return runs.map((run) => ({ ...run, verdicts: { ...run.verdicts } }))
}

export async function fetchCoverage(): Promise<CoverageMatrix> {
  return structuredClone(coverage)
}

export async function fetchCost(): Promise<CostSummary> {
  return structuredClone(cost)
}
