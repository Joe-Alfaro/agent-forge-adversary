import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

import {
  ATTACK_TAXONOMY,
  ATTACK_CATEGORIES,
  isAttackCategory,
  isTaxonomyCell,
  listTaxonomyCells,
} from '../taxonomy.js'
import { validateTaxonomyCell } from '../validate.js'

const require = createRequire(import.meta.url)
const taxonomyJson = require('../../../../contracts/attack_taxonomy/v1.json') as {
  categories: Record<string, string[]>
}

describe('AttackTaxonomy', () => {
  it('has the six PRD categories and 17 cells', () => {
    expect(ATTACK_CATEGORIES).toEqual([
      'prompt_injection',
      'data_exfiltration',
      'state_corruption',
      'tool_misuse',
      'denial_of_service',
      'identity_role',
    ])
    expect(listTaxonomyCells()).toHaveLength(17)
  })

  it('keeps the TypeScript const and the JSON contract in sync', () => {
    const fromConst = Object.fromEntries(
      Object.entries(ATTACK_TAXONOMY).map(([k, v]) => [k, [...v]]),
    )
    expect(taxonomyJson.categories).toEqual(fromConst)
  })

  it('recognises valid cells and rejects unknown ones', () => {
    expect(isTaxonomyCell('prompt_injection', 'multi_turn')).toBe(true)
    expect(isTaxonomyCell('identity_role', 'persona_hijacking')).toBe(true)
    expect(isTaxonomyCell('prompt_injection', 'role_override')).toBe(false)
    expect(isTaxonomyCell('misinformation', 'unsupported_claim')).toBe(false)
    expect(isAttackCategory('identity_role_exploitation')).toBe(false)
  })

  it('validateTaxonomyCell returns structured results', () => {
    expect(validateTaxonomyCell({ category: 'tool_misuse', subcategory: 'recursive_calls' }).valid).toBe(true)
    const bad = validateTaxonomyCell({ category: 'tool_misuse', subcategory: 'nope' })
    expect(bad.valid).toBe(false)
    expect(bad.errors.join(' ')).toContain('not a cell')
  })
})
