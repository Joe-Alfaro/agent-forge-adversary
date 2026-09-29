import { describe, expect, it } from 'vitest'

import { isTaxonomyCell, PRD_CATEGORIES } from '@agentforge/contracts'

import type { CoverageCell } from '../../lib/models.js'
import { computeM5, M5_HIGH_RISK_CELLS, TRACKED_HIGH_RISK_CELLS } from '../m5.js'

const now = new Date('2026-09-29T20:00:00Z')
const options = { now, minAttempts: 20, windowDays: 7 }

function cell(subcategory: CoverageCell['subcategory'], attempts: number, lastRunAt?: string, familiesExercised = 1): CoverageCell {
  const base: CoverageCell = { category: 'prompt_injection', subcategory, owaspIds: [], attempts, confirmed: 0, familiesExercised }
  return lastRunAt ? { ...base, lastRunAt } : base
}

describe('M5_HIGH_RISK_CELLS', () => {
  it('lists the six high-risk cells from THREAT_MODEL.md, all PRD taxonomy cells', () => {
    expect(M5_HIGH_RISK_CELLS).toHaveLength(6)
    M5_HIGH_RISK_CELLS.forEach(({ category, subcategory }) => {
      expect(isTaxonomyCell(category, subcategory)).toBe(true)
      expect(PRD_CATEGORIES).toContain(category)
    })
  })
})

describe('computeM5', () => {
  it('counts a high-risk cell as covered with enough attempts and a recent run', () => {
    const m5 = computeM5([cell('direct', 25, '2026-09-28T06:00:00Z'), cell('indirect', 25, '2026-09-28T06:00:00Z')], options)
    expect(m5).toMatchObject({ total: 6, covered: 2, minAttempts: 20, windowDays: 7 })
    expect(m5.coveredKeys).toEqual(['prompt_injection/direct', 'prompt_injection/indirect'])
    expect(m5.highRiskKeys).toContain('identity_role_exploitation/persona_hijacking')
  })

  it('does not count cells below the attempt threshold or last run more than seven days ago', () => {
    const m5 = computeM5([cell('direct', 19, '2026-09-28T06:00:00Z'), cell('indirect', 500, '2026-09-21T06:00:00Z')], options)
    expect(m5.covered).toBe(0)
  })

  it('requires at least one variant family exercised', () => {
    expect(computeM5([cell('direct', 50, '2026-09-28T06:00:00Z', 0)], options).covered).toBe(0)
  })

  it('tracks the misinformation high cells separately and keeps them out of the fraction', () => {
    expect(TRACKED_HIGH_RISK_CELLS.map((tracked) => `${tracked.category}/${tracked.subcategory}`)).toEqual([
      'misinformation/unsupported_claim',
      'misinformation/fabricated_citation',
    ])
    TRACKED_HIGH_RISK_CELLS.forEach(({ category }) => expect(PRD_CATEGORIES).not.toContain(category))
    const m5 = computeM5(
      [{ category: 'misinformation', subcategory: 'unsupported_claim', owaspIds: [], attempts: 99, confirmed: 0, familiesExercised: 3, lastRunAt: '2026-09-28T06:00:00Z' }],
      options,
    )
    expect(m5).toMatchObject({ total: 6, covered: 0 })
    expect(m5.trackedKeys).toEqual(['misinformation/unsupported_claim', 'misinformation/fabricated_citation'])
  })

  it('ignores cells that are not high risk', () => {
    expect(computeM5([cell('multi_turn', 500, '2026-09-28T06:00:00Z')], options).covered).toBe(0)
  })
})
