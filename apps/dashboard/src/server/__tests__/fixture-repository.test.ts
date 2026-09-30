// @vitest-environment node
import { describe, expect, it } from 'vitest'

import { listTaxonomyCells } from '@agentforge/contracts'

import { buildTrendSeries } from '../../lib/resilience.js'
import { planTonightRows } from '../../lib/tonight.js'
import { createFixtureRepository } from '../fixture-repository.js'
import {
  contractEvents,
  contractNow,
  contractQueue,
  contractReports,
  contractReviews,
  contractScheduledPlan,
  contractTickets,
  describeRepositoryContract,
} from './repository-contract.js'

const config = { envelopeUsd: 25, timeZone: 'America/Chicago', runHour: 1 }

describeRepositoryContract('fixture', {
  setup: async (overrides = {}) =>
    createFixtureRepository({
      config: { ...config, ...overrides },
      now: () => contractNow,
      seed: {
        tickets: contractTickets,
        queueItems: contractQueue,
        reports: contractReports,
        events: contractEvents,
        reviews: contractReviews,
        scheduledPlan: contractScheduledPlan,
      },
    }),
})

describe('fixture repository defaults', () => {
  it('serves the demo fixtures when no seed is given', async () => {
    const repo = createFixtureRepository({ config, now: () => contractNow })
    expect((await repo.listTickets()).length).toBeGreaterThan(3)
    expect((await repo.listRuns()).length).toBeGreaterThan(0)
    expect(await repo.getMorningReport('run-2026-09-28')).not.toBeNull()
  })

  it('keys the demo coverage to the PRD taxonomy and fills its gaps', async () => {
    const taxonomy = listTaxonomyCells()
    const repo = createFixtureRepository({ config, now: () => contractNow, taxonomy })
    const { cells } = await repo.getCoverage()
    expect(cells.map((cell) => `${cell.category}/${cell.subcategory}`)).toEqual(
      taxonomy.map((cell) => `${cell.category}/${cell.subcategory}`),
    )
    expect(cells.filter((cell) => cell.attempts === 0).length).toBeGreaterThan(0)
  })

  it('reports M5 over the high-risk cells', async () => {
    const repo = createFixtureRepository({ config, now: () => contractNow })
    const { m5 } = await repo.getCoverage()
    expect(m5).toMatchObject({ total: 6, minAttempts: 20, windowDays: 7 })
    expect(m5.covered).toBeGreaterThan(0)
    expect(m5.covered).toBeLessThan(6)
  })

  it('keeps demo dates relative to today, so M5 and run history do not go stale', async () => {
    const later = new Date(contractNow.getTime() + 10 * 86_400_000)
    const today = createFixtureRepository({ config, now: () => contractNow })
    const tenDaysOn = createFixtureRepository({ config, now: () => later })
    const [coverageToday, coverageLater] = await Promise.all([today.getCoverage(), tenDaysOn.getCoverage()])
    expect(coverageLater.m5.covered).toBe(coverageToday.m5.covered)
    const [runToday] = await today.listRuns()
    const [runLater] = await tenDaysOn.listRuns()
    expect(Date.parse(runLater?.startedAt ?? '') - Date.parse(runToday?.startedAt ?? '')).toBe(10 * 86_400_000)
    const [queuedToday] = (await today.getQueue()).items
    const [queuedLater] = (await tenDaysOn.getQueue()).items
    expect(Date.parse(queuedLater?.requestedAt ?? '') - Date.parse(queuedToday?.requestedAt ?? '')).toBe(10 * 86_400_000)
    const report = await tenDaysOn.getMorningReport('run-2026-09-28')
    expect(report?.generatedAt.slice(0, 10)).toBe('2026-10-08')
    const [costRun] = (await tenDaysOn.getCost()).byRun
    expect(costRun?.startedAt).toBe(runLater?.startedAt)
  })

  it('names the PRD categories so the heatmap can set the extras apart', async () => {
    const repo = createFixtureRepository({ config, now: () => contractNow })
    const { prdCategories, cells } = await repo.getCoverage()
    expect(prdCategories).toHaveLength(6)
    expect(prdCategories).not.toContain('misinformation')
    expect(cells.some((cell) => cell.category === 'misinformation')).toBe(true)
  })

  it('serves an M4 demo trend with a rubric change', async () => {
    const repo = createFixtureRepository({ config, now: () => contractNow })
    const trend = await repo.getResilienceTrend()
    expect(trend.versions.length).toBeGreaterThan(2)
    expect(buildTrendSeries(trend).rubricChanges.map((change) => change.categories)).toEqual([['prompt_injection']])
  })

  it('simulates the executor: scheduled, then running (queue drained), then completed with a report', async () => {
    const clock = { now: contractNow }
    const repo = createFixtureRepository({
      config,
      now: () => clock.now,
      runNowTimings: { startAfterMs: 1_000, finishAfterMs: 10_000 },
    })
    const queued = (await repo.getQueue()).items
    const [first] = queued
    const run = await repo.runNow({ kind: 'single', operatorRequestId: first?.id ?? '' }, 'operator')
    expect(run.status).toBe('scheduled')
    expect((await repo.getQueue()).items).toHaveLength(queued.length)

    clock.now = new Date(contractNow.getTime() + 2_000)
    expect((await repo.getRun(run.id))?.status).toBe('running')
    expect((await repo.getQueue()).items.map((item) => item.id)).not.toContain(first?.id)
    expect(await repo.getMorningReport(run.id)).toBeNull()

    clock.now = new Date(contractNow.getTime() + 11_000)
    expect(await repo.getRun(run.id)).toMatchObject({ status: 'completed', hasMorningReport: true })
    expect((await repo.getMorningReport(run.id))?.queue).toEqual({ ran: 1, cut: 0 })
    await expect(repo.runNow({ kind: 'queue' }, 'operator')).resolves.toMatchObject({ status: 'scheduled' })
  })

  it('has no plan when nothing is scheduled', async () => {
    const repo = createFixtureRepository({
      config,
      now: () => contractNow,
      seed: { tickets: contractTickets, queueItems: contractQueue },
    })
    expect((await repo.getQueue()).plan).toBeNull()
  })

  it('demos a preview plan: OWASP-tagged coverage campaigns, some cut by the envelope', async () => {
    const repo = createFixtureRepository({ config, now: () => contractNow })
    const queue = await repo.getQueue()
    const campaigns = queue.plan?.items ?? []
    expect(campaigns.length).toBeGreaterThan(3)
    expect(campaigns.every((campaign) => campaign.owaspIds.length > 0)).toBe(true)
    const rows = planTonightRows(queue.items, campaigns, queue.plan?.budgetUsd ?? queue.envelopeUsd)
    expect(rows.some((row) => row.source === 'orchestrator' && row.decision === 'cut')).toBe(true)
    expect(rows.some((row) => row.source === 'orchestrator' && row.decision === 'run')).toBe(true)
  })
})
