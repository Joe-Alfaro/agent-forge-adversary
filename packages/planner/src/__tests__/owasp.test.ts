import { describe, expect, it } from 'vitest'

import { listTaxonomyCells } from '@agentforge/contracts'

import { buildCellOwaspMap, unmappedCells } from '../owasp.js'
import { SEED_INDEX } from '../seedIndex.js'

describe('buildCellOwaspMap', () => {
  it('unions LLM ids then web ids per cell, deduplicated', () => {
    const map = buildCellOwaspMap([
      { category: 'prompt_injection', subcategory: 'direct', owasp_llm_ids: ['LLM01'], owasp_ids: ['A03'] },
      { category: 'prompt_injection', subcategory: 'direct', owasp_llm_ids: ['LLM07', 'LLM01'], owasp_ids: ['A03'] },
    ])
    expect(map['prompt_injection/direct']).toEqual(['LLM01', 'LLM07', 'A03'])
  })

  it('reports cells with no mapping', () => {
    const map = buildCellOwaspMap([{ category: 'prompt_injection', subcategory: 'direct', owasp_llm_ids: ['LLM01'], owasp_ids: [] }])
    const missing = unmappedCells(map)
    expect(missing).toContain('prompt_injection/indirect')
    expect(missing).not.toContain('prompt_injection/direct')
  })

  it('maps every AttackTaxonomy v1 cell to at least one OWASP id from the seed suite', () => {
    const map = buildCellOwaspMap([...SEED_INDEX])
    expect(unmappedCells(map)).toEqual([])
    listTaxonomyCells().forEach((cell) => {
      const ids = map[`${cell.category}/${cell.subcategory}`] ?? []
      expect(ids.length).toBeGreaterThan(0)
      ids.forEach((id) => expect(id).toMatch(/^(LLM[0-9]{2}|A[0-9]{2})$/))
    })
  })
})
