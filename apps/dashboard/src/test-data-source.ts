import type * as DataSource from './lib/data-source.js'
import type { DataSourceMode } from './lib/data-source.js'
import { createFixtureRepository } from './server/fixture-repository.js'
import type { DashboardRepository } from './server/repository.js'

/*
 * Stand-in for lib/data-source.ts in component tests, where there is no Start
 * server to answer server functions. It calls the fixture repository directly,
 * so components exercise the same rules the server enforces. Use with:
 *   vi.mock('<path>/lib/data-source.js', () => import('<path>/test-data-source.js'))
 */

/** 2026-09-29 15:00 CDT: tonight's run date is 2026-09-30. */
export const TEST_NOW = new Date('2026-09-29T20:00:00Z')

function freshRepository(): DashboardRepository {
  return createFixtureRepository({
    config: { envelopeUsd: 25, timeZone: 'America/Chicago', runHour: 1 },
    now: () => TEST_NOW,
  })
}

const state = { repository: freshRepository() }

/** Restores the fixtures between tests. */
export function resetTestData(): void {
  state.repository = freshRepository()
}

export const fetchDataSourceMode: typeof DataSource.fetchDataSourceMode = async (): Promise<DataSourceMode> => 'fixtures'
export const fetchTickets: typeof DataSource.fetchTickets = () => state.repository.listTickets()
export const fetchTicket: typeof DataSource.fetchTicket = (id) => state.repository.getTicket(id)
export const fetchRuns: typeof DataSource.fetchRuns = () => state.repository.listRuns()
export const fetchCoverage: typeof DataSource.fetchCoverage = () => state.repository.getCoverage()
export const fetchCost: typeof DataSource.fetchCost = () => state.repository.getCost()
export const fetchQueue: typeof DataSource.fetchQueue = () => state.repository.getQueue()
export const fetchMorningReport: typeof DataSource.fetchMorningReport = (runId) =>
  state.repository.getMorningReport(runId)
export const updateTicket: typeof DataSource.updateTicket = (id, update) => state.repository.updateTicket(id, update)
export const enqueueRerun: typeof DataSource.enqueueRerun = (request) => state.repository.enqueueRerun(request)
export const removeQueueItem: typeof DataSource.removeQueueItem = (id) => state.repository.removeQueueItem(id)
export const moveQueueItem: typeof DataSource.moveQueueItem = (id, direction) =>
  state.repository.moveQueueItem(id, direction)
export const fetchApprovals: typeof DataSource.fetchApprovals = () => state.repository.listApprovals()
export const decideApproval: typeof DataSource.decideApproval = (reportId, decision) =>
  state.repository.decideApproval(reportId, decision, 'operator')
