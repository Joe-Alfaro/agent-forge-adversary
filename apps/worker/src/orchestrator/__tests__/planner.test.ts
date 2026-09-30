import { describe, expect, it } from 'vitest'

import { validateNightlyPlan } from '@agentforge/contracts'

import { buildNightlyPlan, type PlannerInputs } from '../planner.js'
import { DEFAULT_WEIGHTS, type CoverageCellInput } from '../priority.js'

function baseInputs(over: Partial<PlannerInputs> = {}): PlannerInputs {
  const cells: CoverageCellInput[] = [
    {
      category: 'data_exfiltration',
      subcategory: 'cross_patient',
      attempts: 0,
      targetAttempts: 10,
      openFindings: [],
      regressedThisVersion: false,
      recentSignalPerDollar: 0,
      daysSinceLastRun: 5,
      predictedCostUsd: 0.5,
    },
    {
      category: 'prompt_injection',
      subcategory: 'direct',
      attempts: 10,
      targetAttempts: 10,
      openFindings: [],
      regressedThisVersion: false,
      recentSignalPerDollar: 0,
      daysSinceLastRun: 1,
      predictedCostUsd: 0.5,
    },
  ]
  return {
    trigger: 'run_now',
    targetVersion: 'copilot@c1f011e',
    budgetUsd: 3,
    weights: DEFAULT_WEIGHTS,
    operatorRequests: [],
    coverageCells: cells,
    seedsByCell: { 'data_exfiltration/cross_patient': ['de-002'], 'prompt_injection/direct': ['pi-001'] },
    costPerAttemptUsd: 0.1,
    maxAttemptsPerCampaign: 5,
    topK: 5,
    messageId: '11111111-1111-4111-8111-111111111111',
    traceId: 'nightly-test',
    now: new Date('2026-09-29T06:00:00Z'),
    ...over,
  }
}

describe('buildNightlyPlan', () => {
  it('produces a schema-valid NightlyPlan', () => {
    const plan = buildNightlyPlan(baseInputs())
    const result = validateNightlyPlan(plan)
    expect(result.errors).toEqual([])
  })

  it('orders operator rerun requests before coverage campaigns', () => {
    const plan = buildNightlyPlan(
      baseInputs({
        operatorRequests: [
          {
            id: '22222222-2222-4222-8222-222222222222',
            kind: 'rerun',
            exploit_id: 'AF-2026-0001',
            category: 'prompt_injection',
            subcategory: 'direct',
          },
        ],
      }),
    )
    expect(plan.items[0]?.kind).toBe('operator_request')
    expect(plan.items[0]?.exploit_id).toBe('AF-2026-0001')
  })

  it('records the priority-score breakdown and weights on coverage items', () => {
    const plan = buildNightlyPlan(baseInputs())
    const coverage = plan.items.find((i) => i.kind === 'coverage_campaign')
    expect(coverage?.score).toBeDefined()
    expect(coverage?.priority).toBeGreaterThan(0)
    expect(plan.weights).toEqual(DEFAULT_WEIGHTS)
  })

  it('cuts items that exceed the budget envelope and counts run vs cut', () => {
    const plan = buildNightlyPlan(baseInputs({ budgetUsd: 0.5, costPerAttemptUsd: 0.1, maxAttemptsPerCampaign: 5 }))
    // First campaign costs 0.5; the second must be cut.
    expect(plan.items.some((i) => i.decision === 'cut')).toBe(true)
    expect(plan.run_count + plan.cut_count).toBe(plan.items.length)
    expect(plan.run_count).toBeGreaterThanOrEqual(1)
  })

  it('estimated_cost_usd equals the sum of run items only', () => {
    const plan = buildNightlyPlan(baseInputs({ budgetUsd: 0.5 }))
    const runSum = plan.items
      .filter((i) => i.decision === 'run')
      .reduce((s, i) => s + i.estimated_cost_usd, 0)
    expect(plan.estimated_cost_usd).toBeCloseTo(runSum, 6)
  })

  it('drops coverage cells for a skipped category and notes it', () => {
    const plan = buildNightlyPlan(
      baseInputs({
        operatorRequests: [{ id: '33333333-3333-4333-8333-333333333333', kind: 'skip', category: 'data_exfiltration' }],
      }),
    )
    expect(plan.items.some((i) => i.kind === 'coverage_campaign' && i.category === 'data_exfiltration')).toBe(false)
    expect(plan.notes?.some((n) => n.includes('data_exfiltration'))).toBe(true)
  })

  it('honours topK by limiting the number of coverage campaigns considered', () => {
    const plan = buildNightlyPlan(baseInputs({ topK: 1 }))
    expect(plan.items.filter((i) => i.kind === 'coverage_campaign').length).toBeLessThanOrEqual(1)
  })
})
