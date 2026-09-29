import { describe, expect, it } from 'vitest'

import { coverageGrid, mergeCoverage, taxonomyCells } from '../coverage.js'
import type { CoverageCell } from '../models.js'
import { ATTACK_TAXONOMY } from '../taxonomy.js'

describe('taxonomyCells', () => {
  it('lists every category × subcategory in taxonomy order', () => {
    const cells = taxonomyCells({ tool_misuse: ['unintended_invocation', 'recursive_calls'], prompt_injection: ['direct'] })
    expect(cells).toEqual([
      { category: 'tool_misuse', subcategory: 'unintended_invocation' },
      { category: 'tool_misuse', subcategory: 'recursive_calls' },
      { category: 'prompt_injection', subcategory: 'direct' },
    ])
  })

  it('covers the PRD taxonomy: six categories, seventeen subcategories', () => {
    const cells = taxonomyCells(ATTACK_TAXONOMY)
    expect(new Set(cells.map((cell) => cell.category)).size).toBe(6)
    expect(cells).toHaveLength(17)
  })
})

describe('mergeCoverage', () => {
  const live: CoverageCell[] = [
    { category: 'tool_misuse', subcategory: 'parameter_tampering', owaspIds: ['LLM06'], attempts: 5, confirmed: 1, lastRunAt: '2026-09-29T06:00:00.000Z' },
    { category: 'legacy', subcategory: 'old_probe', owaspIds: [], attempts: 2, confirmed: 0 },
  ]
  const taxonomy = [
    { category: 'tool_misuse', subcategory: 'unintended_invocation' },
    { category: 'tool_misuse', subcategory: 'parameter_tampering' },
  ]

  it('renders every taxonomy cell in taxonomy order, zero attempts included, then data-only cells', () => {
    expect(mergeCoverage(live, taxonomy)).toEqual([
      { category: 'tool_misuse', subcategory: 'unintended_invocation', owaspIds: [], attempts: 0, confirmed: 0 },
      live[0],
      live[1],
    ])
  })

  it('sorts data-only cells by category and subcategory when there is no taxonomy', () => {
    expect(mergeCoverage(live, [])).toEqual([live[1], live[0]])
  })
})

describe('coverageGrid', () => {
  it('groups cells into category rows, keeping order and scaling intensity to the busiest cell', () => {
    const grid = coverageGrid([
      { category: 'a', subcategory: 'x', owaspIds: [], attempts: 100, confirmed: 0 },
      { category: 'b', subcategory: 'y', owaspIds: [], attempts: 0, confirmed: 0 },
      { category: 'a', subcategory: 'z', owaspIds: [], attempts: 10, confirmed: 2 },
    ])
    expect(grid.map((row) => [row.category, row.cells.map((cell) => [cell.subcategory, cell.level])])).toEqual([
      ['a', [['x', 5], ['z', 1]]],
      ['b', [['y', 0]]],
    ])
  })
})
