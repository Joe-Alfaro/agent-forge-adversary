import { describe, expect, it } from 'vitest'

import { coverageGrid, mergeCoverage } from '../coverage.js'
import type { CoverageCell } from '../models.js'

describe('mergeCoverage', () => {
  const live: CoverageCell[] = [
    { category: 'tool_misuse', subcategory: 'parameter_tampering', owaspIds: ['LLM06'], attempts: 5, confirmed: 1, lastRunAt: '2026-09-29T06:00:00.000Z' },
  ]

  it('returns exactly the taxonomy cells, in taxonomy order, with zero attempts where untested', () => {
    expect(
      mergeCoverage(live, [
        { category: 'tool_misuse', subcategory: 'unintended_invocation' },
        { category: 'tool_misuse', subcategory: 'parameter_tampering' },
      ]),
    ).toEqual([
      { category: 'tool_misuse', subcategory: 'unintended_invocation', owaspIds: [], attempts: 0, confirmed: 0 },
      live[0],
    ])
  })
})

describe('coverageGrid', () => {
  it('groups cells into category rows, keeping order and scaling intensity to the busiest cell', () => {
    const grid = coverageGrid([
      { category: 'prompt_injection', subcategory: 'direct', owaspIds: [], attempts: 100, confirmed: 0 },
      { category: 'tool_misuse', subcategory: 'loops', owaspIds: [], attempts: 0, confirmed: 0 },
      { category: 'prompt_injection', subcategory: 'indirect', owaspIds: [], attempts: 10, confirmed: 2 },
    ])
    expect(grid.map((row) => [row.category, row.cells.map((cell) => [cell.subcategory, cell.level])])).toEqual([
      ['prompt_injection', [['direct', 5], ['indirect', 1]]],
      ['tool_misuse', [['loops', 0]]],
    ])
  })
})
