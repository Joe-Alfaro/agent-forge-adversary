import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { SEED_INDEX } from '../seedIndex.js'

const seedDir = fileURLToPath(new URL('../../../../evals/seeds', import.meta.url))

interface SeedFileCase {
  id: string
  category: string
  subcategory: string
  owasp_llm_ids: string[]
  owasp_ids: string[]
}

describe('SEED_INDEX', () => {
  it('matches evals/seeds exactly (run `npm run seeds:sync -w packages/planner` if this fails)', () => {
    const fromDisk = readdirSync(seedDir)
      .filter((f) => f.endsWith('.json'))
      .sort()
      .flatMap((f) => {
        const parsed = JSON.parse(readFileSync(`${seedDir}/${f}`, 'utf8')) as SeedFileCase[] | { cases: SeedFileCase[] }
        const cases = Array.isArray(parsed) ? parsed : parsed.cases
        return cases.map((c) => ({ id: c.id, category: c.category, subcategory: c.subcategory, owasp_llm_ids: c.owasp_llm_ids, owasp_ids: c.owasp_ids }))
      })
    expect(SEED_INDEX).toEqual(fromDisk)
  })
})
