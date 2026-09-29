import { describe, expect, it } from 'vitest'

import type { CoverageCell } from '../models.js'
import { computeM5, M5_HIGH_RISK_CELLS } from '../m5.js'
import { ATTACK_TAXONOMY } from '../taxonomy.js'

const now = new Date('2026-09-29T20:00:00Z')
const options = { now, minAttempts: 20, windowDays: 7 }

function cell(subcategory: string, attempts: number, lastRunAt?: string): CoverageCell {
  const base = { category: 'prompt_injection', subcategory, owaspIds: [], attempts, confirmed: 0 }
  return lastRunAt ? { ...base, lastRunAt } : base
}

describe('M5_HIGH_RISK_CELLS', () => {
  it('lists the six PRD high-risk cells from THREAT_MODEL.md, all inside the taxonomy', () => {
    expect(M5_HIGH_RISK_CELLS).toHaveLength(6)
    M5_HIGH_RISK_CELLS.forEach(({ category, subcategory }) => {
      const subcategories: readonly string[] = ATTACK_TAXONOMY[category]
      expect(subcategories).toContain(subcategory)
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

  it('ignores cells that are not high risk', () => {
    expect(computeM5([cell('multi_turn', 500, '2026-09-28T06:00:00Z')], options).covered).toBe(0)
  })
})
