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

  it('orders items per 7.0: operator reruns, then owed regressions (target change first), then coverage', () => {
    const plan = buildNightlyPlan(
      baseInputs({
        budgetUsd: 100,
        operatorRequests: [
          { id: '22222222-2222-4222-8222-222222222222', kind: 'rerun', exploit_id: 'AF-2026-0001', category: 'prompt_injection', subcategory: 'direct' },
        ],
        regressions: [
          { exploitId: 'AF-2026-0003', category: 'tool_misuse', subcategory: 'recursive_calls', cause: 'ticket_fixed' },
          { exploitId: 'AF-2026-0002', category: 'data_exfiltration', subcategory: 'phi_leakage', cause: 'target_changed' },
        ],
      }),
    )
    expect(plan.items.map((i) => i.kind)).toEqual(['operator_request', 'regression', 'regression', 'coverage_campaign', 'coverage_campaign'])
    expect(plan.items[1]).toMatchObject({ exploit_id: 'AF-2026-0002', regression_cause: 'target_changed' })
    expect(plan.items[2]).toMatchObject({ exploit_id: 'AF-2026-0003', regression_cause: 'ticket_fixed' })
    expect(validateNightlyPlan(plan).errors).toEqual([])
  })

  it('does not duplicate a regression the operator already queued as a rerun', () => {
    const plan = buildNightlyPlan(
      baseInputs({
        operatorRequests: [{ id: '22222222-2222-4222-8222-222222222222', kind: 'rerun', exploit_id: 'AF-2026-0001', category: 'prompt_injection', subcategory: 'direct' }],
        regressions: [{ exploitId: 'AF-2026-0001', category: 'prompt_injection', subcategory: 'direct', cause: 'ticket_fixed' }],
      }),
    )
    expect(plan.items.filter((i) => i.exploit_id === 'AF-2026-0001')).toHaveLength(1)
  })

  it('prices regressions as majority-vote replays and reruns by their own estimate', () => {
    const plan = buildNightlyPlan(
      baseInputs({
        budgetUsd: 100,
        costPerAttemptUsd: 0.05,
        operatorRequests: [{ id: '22222222-2222-4222-8222-222222222222', kind: 'rerun', exploit_id: 'AF-2026-0001', category: 'prompt_injection', estimatedCostUsd: 0.45 }],
        regressions: [{ exploitId: 'AF-2026-0002', category: 'data_exfiltration', subcategory: 'phi_leakage', cause: 'ticket_fixed' }],
      }),
    )
    expect(plan.items[0]?.estimated_cost_usd).toBeCloseTo(0.45, 6)
    expect(plan.items[1]?.estimated_cost_usd).toBeCloseTo(0.15, 6)
    expect(plan.items[1]?.max_attempts).toBe(3)
  })

  it('attaches the cell OWASP mapping to every coverage campaign and to cell-known reruns/regressions', () => {
    const plan = buildNightlyPlan(
      baseInputs({
        operatorRequests: [{ id: '22222222-2222-4222-8222-222222222222', kind: 'rerun', category: 'prompt_injection', subcategory: 'direct' }],
        regressions: [{ exploitId: 'AF-2026-0002', category: 'data_exfiltration', subcategory: 'cross_patient', cause: 'ticket_fixed', owaspIds: ['LLM02'] }],
        owaspByCell: { 'data_exfiltration/cross_patient': ['LLM02', 'A01'], 'prompt_injection/direct': ['LLM01', 'A03'] },
      }),
    )
    plan.items
      .filter((i) => i.kind === 'coverage_campaign')
      .forEach((i) => expect(i.owasp_ids?.length).toBeGreaterThan(0))
    expect(plan.items.find((i) => i.kind === 'coverage_campaign' && i.subcategory === 'cross_patient')?.owasp_ids).toEqual(['LLM02', 'A01'])
    expect(plan.items[0]?.owasp_ids).toEqual(['LLM01', 'A03'])
    // The exploit's own stored OWASP ids win over the cell mapping.
    expect(plan.items[1]?.owasp_ids).toEqual(['LLM02'])
    expect(validateNightlyPlan(plan).errors).toEqual([])
  })

  it('refuses to emit a coverage campaign whose cell has no OWASP mapping when a map is supplied', () => {
    expect(() =>
      buildNightlyPlan(baseInputs({ owaspByCell: { 'prompt_injection/direct': ['LLM01'] } })),
    ).toThrow(/OWASP/)
  })

  it('marks run/cut in 7.0 order against the envelope: reruns and regressions win the budget', () => {
    const plan = buildNightlyPlan(
      baseInputs({
        budgetUsd: 0.7,
        costPerAttemptUsd: 0.1,
        maxAttemptsPerCampaign: 5,
        operatorRequests: [{ id: '22222222-2222-4222-8222-222222222222', kind: 'rerun', category: 'prompt_injection', estimatedCostUsd: 0.3 }],
        regressions: [{ exploitId: 'AF-2026-0002', category: 'data_exfiltration', subcategory: 'phi_leakage', cause: 'ticket_fixed' }],
      }),
    )
    // 0.3 rerun + 0.3 regression = 0.6; each 0.5 coverage campaign is over the 0.7 envelope.
    expect(plan.items.map((i) => i.decision)).toEqual(['run', 'run', 'cut', 'cut'])
    expect(plan.run_count).toBe(2)
    expect(plan.cut_count).toBe(2)
    expect(plan.estimated_cost_usd).toBeCloseTo(0.6, 6)
  })
})
