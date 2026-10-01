import { describe, expect, it } from 'vitest'

import { listTaxonomyCells } from '@agentforge/contracts'

import { loadPlanningSeeds, resolveSeedDir } from '../index.js'

describe('planning seeds', () => {
  it('resolves evals/seeds from the package location, overridable by AGENTFORGE_SEED_DIR', () => {
    expect(resolveSeedDir({})).toMatch(/evals\/seeds$/)
    expect(resolveSeedDir({ AGENTFORGE_SEED_DIR: '/opt/seeds' })).toBe('/opt/seeds')
  })

  it('loads a seed suite that covers every taxonomy cell', () => {
    const seeds = loadPlanningSeeds({})
    const cells = new Set(seeds.map((s) => `${s.category}/${s.subcategory}`))
    listTaxonomyCells().forEach((c) => expect(cells.has(`${c.category}/${c.subcategory}`)).toBe(true))
  })
})
