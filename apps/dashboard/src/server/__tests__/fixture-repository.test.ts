// @vitest-environment node
import { describe, expect, it } from 'vitest'

import { listTaxonomyCells } from '@agentforge/contracts'

import { createFixtureRepository } from '../fixture-repository.js'
import {
  contractNow,
  contractQueue,
  contractReports,
  contractTickets,
  describeRepositoryContract,
} from './repository-contract.js'

const config = { envelopeUsd: 25, timeZone: 'America/Chicago', runHour: 1 }

describeRepositoryContract('fixture', {
  setup: async () =>
    createFixtureRepository({
      config,
      now: () => contractNow,
      seed: { tickets: contractTickets, queueItems: contractQueue, reports: contractReports },
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
})
