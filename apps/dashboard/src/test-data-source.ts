import type * as DataSource from './lib/data-source.js'
import type { DataSourceMode } from './lib/data-source.js'
import { createFixtureRepository, demoSeed, type FixtureSeed } from './server/fixture-repository.js'
import type { DashboardRepository } from './server/repository.js'

/*
 * Stand-in for lib/data-source.ts in component tests, where there is no Start
 * server to answer server functions. It calls the fixture repository directly,
 * so components exercise the same rules the server enforces. Use with:
 *   vi.mock('<path>/lib/data-source.js', () => import('<path>/test-data-source.js'))
 */

/** 2026-09-29 15:00 CDT: tonight's run date is 2026-09-30. */
export const TEST_NOW = new Date('2026-09-29T20:00:00Z')

const clock = { now: TEST_NOW }
const flags: { runNowEnabled: boolean; noPlan: boolean } = { runNowEnabled: true, noPlan: false }

/** Simulated run-nows start after 1 s and complete after 10 s of test-clock time. */
function freshRepository(): DashboardRepository {
  return createFixtureRepository({
    config: { envelopeUsd: 25, timeZone: 'America/Chicago', runHour: 1, runNowEnabled: flags.runNowEnabled },
    now: () => clock.now,
    runNowTimings: { startAfterMs: 1_000, finishAfterMs: 10_000 },
    ...(flags.noPlan ? { seed: withoutPlan() } : {}),
  })
}

function withoutPlan(): FixtureSeed {
  const { scheduledPlan: _plan, ...seed } = demoSeed()
  return seed
}

const state = { repository: freshRepository() }

/** Restores the fixtures and the clock between tests. */
export function resetTestData(): void {
  clock.now = TEST_NOW
  flags.runNowEnabled = true
  flags.noPlan = false
  state.repository = freshRepository()
}

/** Recreates the store as a deployment with RUN_NOW_ENABLED set to `enabled`. */
export function setRunNowEnabled(enabled: boolean): void {
  flags.runNowEnabled = enabled
  state.repository = freshRepository()
}

/** Recreates the store with no scheduled plan (`null`), as before the Orchestrator has planned tonight. */
export function setScheduledPlan(plan: null): void {
  flags.noPlan = plan === null
  state.repository = freshRepository()
}

/** Moves the fixture clock forward, e.g. to let a simulated run-now finish. */
export function advanceTestClock(ms: number): void {
  clock.now = new Date(clock.now.getTime() + ms)
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
export const fetchResilienceTrend: typeof DataSource.fetchResilienceTrend = () => state.repository.getResilienceTrend()
export const fetchAgentEvents: typeof DataSource.fetchAgentEvents = () => state.repository.listAgentEvents(100)
export const fetchNeedsReview: typeof DataSource.fetchNeedsReview = () => state.repository.listNeedsReview()
export const fetchJudgeHealth: typeof DataSource.fetchJudgeHealth = () => state.repository.getJudgeHealth()
export const resolveReview: typeof DataSource.resolveReview = (verdictId, review) =>
  state.repository.resolveReview(verdictId, review, 'operator')
export const fetchRun: typeof DataSource.fetchRun = (runId) => state.repository.getRun(runId)
export const runNow: typeof DataSource.runNow = (scope) => state.repository.runNow(scope, 'operator')
export const updateNightlyBudget: typeof DataSource.updateNightlyBudget = (budgetUsd) =>
  state.repository.updateNightlyBudget(budgetUsd, 'operator')
