import { describe, expect, it } from 'vitest'

import { validateNightlyPlan } from '../validate.js'
import type { NightlyPlan } from '../types.js'

const valid: NightlyPlan = {
  schema_version: '1',
  message_id: '11111111-1111-4111-8111-111111111111',
  trace_id: 'nightly-2026-09-29',
  produced_by: 'orchestrator',
  produced_at: '2026-09-29T06:00:00.000Z',
  trigger: 'run_now',
  target_version: 'copilot@c1f011e',
  budget_usd: 3,
  estimated_cost_usd: 1.2,
  weights: { gap: 1, open: 0.5, regress: 2, yield: 0.5, stale: 0.2, cost: 0.3 },
  items: [
    {
      item_id: 'req-1',
      kind: 'operator_request',
      request_id: '22222222-2222-4222-8222-222222222222',
      request_kind: 'rerun',
      exploit_id: 'AF-2026-0001',
      category: 'prompt_injection',
      subcategory: 'direct',
      seed_case_ids: [],
      max_attempts: 3,
      estimated_cost_usd: 0.2,
      decision: 'run',
      reason: 'operator rerun, queue position 1',
    },
    {
      item_id: 'cell-data_exfiltration-cross_patient',
      kind: 'coverage_campaign',
      category: 'data_exfiltration',
      subcategory: 'cross_patient',
      priority: 1.75,
      score: { gap: 1, open: 0, regress: 0, yield: 0, stale: 1, cost: 0.25 },
      seed_case_ids: ['de-002'],
      max_attempts: 5,
      estimated_cost_usd: 1,
      decision: 'cut',
      reason: 'over budget envelope',
    },
  ],
  run_count: 1,
  cut_count: 1,
}

describe('validateNightlyPlan', () => {
  it('accepts a well-formed plan', () => {
    const result = validateNightlyPlan(valid)
    expect(result.errors).toEqual([])
    expect(result.value?.items).toHaveLength(2)
  })

  it('accepts an empty plan', () => {
    expect(validateNightlyPlan({ ...valid, items: [], run_count: 0, cut_count: 0 }).valid).toBe(true)
  })

  it('rejects an unknown item kind', () => {
    const items = [{ ...valid.items[0], kind: 'vibes' }]
    expect(validateNightlyPlan({ ...valid, items }).valid).toBe(false)
  })

  it('rejects an unknown decision', () => {
    const items = [{ ...valid.items[0], decision: 'maybe' }]
    expect(validateNightlyPlan({ ...valid, items }).valid).toBe(false)
  })

  it('rejects a negative budget', () => {
    expect(validateNightlyPlan({ ...valid, budget_usd: -1 }).valid).toBe(false)
  })

  it('rejects unknown top-level properties', () => {
    expect(validateNightlyPlan({ ...valid, surprise: true }).valid).toBe(false)
  })

  it('rejects a wrong producer', () => {
    expect(validateNightlyPlan({ ...valid, produced_by: 'redteam' }).valid).toBe(false)
  })
})
