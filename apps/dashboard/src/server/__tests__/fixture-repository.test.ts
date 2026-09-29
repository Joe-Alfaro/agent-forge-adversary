// @vitest-environment node
import { describe, expect, it } from 'vitest'

import { taxonomyCells } from '../../lib/coverage.js'
import { ATTACK_TAXONOMY } from '../../lib/taxonomy.js'
import { createFixtureRepository } from '../fixture-repository.js'
import { contractNow, contractQueue, contractTickets, describeRepositoryContract } from './repository-contract.js'

const config = { envelopeUsd: 25, timeZone: 'America/Chicago', runHour: 1 }

describeRepositoryContract('fixture', {
  setup: async () =>
    createFixtureRepository({ config, now: () => contractNow, seed: { tickets: contractTickets, queueItems: contractQueue } }),
  supportsReorder: () => true,
})

describe('fixture repository defaults', () => {
  it('serves the demo fixtures when no seed is given', async () => {
    const repo = createFixtureRepository({ config, now: () => contractNow })
    expect((await repo.listTickets()).length).toBeGreaterThan(3)
    expect((await repo.listRuns()).length).toBeGreaterThan(0)
    expect(await repo.getMorningReport('run-2026-09-28')).not.toBeNull()
  })

  it('keys the demo coverage to the PRD taxonomy and fills its gaps', async () => {
    const taxonomy = taxonomyCells(ATTACK_TAXONOMY)
    const repo = createFixtureRepository({ config, now: () => contractNow, taxonomy })
    const { cells } = await repo.getCoverage()
    expect(cells.map((cell) => `${cell.category}/${cell.subcategory}`)).toEqual(
      taxonomy.map((cell) => `${cell.category}/${cell.subcategory}`),
    )
    expect(cells.filter((cell) => cell.attempts === 0).length).toBeGreaterThan(0)
  })
})
