import { describe, expect, it } from 'vitest'

import {
  DEFAULT_WEIGHTS,
  SEVERITY_WEIGHT,
  openSeverityWeight,
  rankCells,
  type CoverageCellInput,
} from '../priority.js'

function cell(over: Partial<CoverageCellInput>): CoverageCellInput {
  return {
    category: 'prompt_injection',
    subcategory: 'direct',
    attempts: 0,
    targetAttempts: 10,
    openFindings: [],
    regressedThisVersion: false,
    recentSignalPerDollar: 0,
    daysSinceLastRun: 0,
    predictedCostUsd: 0.1,
    ...over,
  }
}

describe('openSeverityWeight', () => {
  it('sums severity weights for open findings', () => {
    expect(openSeverityWeight([{ severity: 'critical' }, { severity: 'low' }])).toBe(
      SEVERITY_WEIGHT.critical + SEVERITY_WEIGHT.low,
    )
  })
})

describe('rankCells', () => {
  it('ranks a wholly-uncovered cell above a fully-covered one', () => {
    const ranked = rankCells(
      [
        cell({ subcategory: 'direct', attempts: 0 }),
        cell({ subcategory: 'indirect', attempts: 10 }),
      ],
      DEFAULT_WEIGHTS,
    )
    expect(ranked[0]?.subcategory).toBe('direct')
    expect(ranked[0]?.priority).toBeGreaterThan(ranked[1]?.priority ?? 0)
  })

  it('coverage_gap is 1 for zero attempts and 0 when the target is met', () => {
    const ranked = rankCells([cell({ attempts: 0 }), cell({ subcategory: 'indirect', attempts: 20, targetAttempts: 10 })], DEFAULT_WEIGHTS)
    const direct = ranked.find((r) => r.subcategory === 'direct')
    const indirect = ranked.find((r) => r.subcategory === 'indirect')
    expect(direct?.score.gap).toBe(1)
    expect(indirect?.score.gap).toBe(0)
  })

  it('open findings raise priority', () => {
    const ranked = rankCells(
      [
        cell({ subcategory: 'direct', attempts: 10, openFindings: [{ severity: 'critical' }] }),
        cell({ subcategory: 'indirect', attempts: 10 }),
      ],
      DEFAULT_WEIGHTS,
    )
    expect(ranked[0]?.subcategory).toBe('direct')
  })

  it('a recent regression dominates via the regress term', () => {
    const ranked = rankCells(
      [
        cell({ subcategory: 'direct', attempts: 10, regressedThisVersion: true }),
        cell({ subcategory: 'indirect', attempts: 0 }),
      ],
      { ...DEFAULT_WEIGHTS, regress: 5 },
    )
    expect(ranked[0]?.subcategory).toBe('direct')
  })

  it('normalizes yield and cost across the candidate set (values in [0,1])', () => {
    const ranked = rankCells(
      [
        cell({ subcategory: 'direct', predictedCostUsd: 1, recentSignalPerDollar: 10 }),
        cell({ subcategory: 'indirect', predictedCostUsd: 0.1, recentSignalPerDollar: 0 }),
      ],
      DEFAULT_WEIGHTS,
    )
    ranked.forEach((r) => {
      expect(r.score.yield).toBeGreaterThanOrEqual(0)
      expect(r.score.yield).toBeLessThanOrEqual(1)
      expect(r.score.cost).toBeGreaterThanOrEqual(0)
      expect(r.score.cost).toBeLessThanOrEqual(1)
    })
  })

  it('caps staleness so an ancient cell does not swamp the score', () => {
    const ranked = rankCells([cell({ daysSinceLastRun: 9999 })], DEFAULT_WEIGHTS)
    expect(ranked[0]?.score.stale).toBeLessThanOrEqual(1)
  })

  it('is a pure ranking: input order does not change the result set', () => {
    const cells = [cell({ subcategory: 'direct', attempts: 3 }), cell({ subcategory: 'indirect', attempts: 7 })]
    const a = rankCells(cells, DEFAULT_WEIGHTS).map((r) => r.subcategory)
    const b = rankCells([...cells].reverse(), DEFAULT_WEIGHTS).map((r) => r.subcategory)
    expect(a).toEqual(b)
  })
})
