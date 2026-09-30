import { describe, expect, it } from 'vitest'

import type { QueueItem } from '../models.js'
import { type PlanCampaign, parsePlanCampaigns, parseTonightPlan, planTonightRows } from '../tonight.js'

function request(id: string, estimatedCostUsd: number, kind: QueueItem['kind'] = 'rerun'): QueueItem {
  return {
    id,
    kind,
    exploitId: `AF-${id}`,
    requestedBy: 'dana',
    requestedAt: '2026-09-29T10:00:00Z',
    source: 'ui',
    estimatedCostUsd,
  }
}

function campaign(itemId: string, estimatedCostUsd: number, priority: number): PlanCampaign {
  return {
    itemId,
    category: 'prompt_injection',
    subcategory: 'direct',
    owaspIds: ['LLM01'],
    priority,
    estimatedCostUsd,
    maxAttempts: 20,
    reason: `coverage priority ${priority}`,
  }
}

describe('planTonightRows', () => {
  const rows = planTonightRows(
    [request('r1', 2), request('r2', 1)],
    [campaign('c1', 5, 0.9), campaign('c2', 4, 0.7), campaign('c3', 1, 0.5)],
    10,
  )

  it('puts operator requests first, in queue order, then the plan’s campaigns in plan order', () => {
    expect(rows.map((row) => row.key)).toEqual(['r1', 'r2', 'c1', 'c2', 'c3'])
    expect(rows.map((row) => row.position)).toEqual([1, 2, 3, 4, 5])
    expect(rows.map((row) => row.source)).toEqual(['operator', 'operator', 'orchestrator', 'orchestrator', 'orchestrator'])
  })

  it('runs each item that still fits the envelope and cuts the rest, as the planner does', () => {
    // 2 + 1 + 5 = 8; c2 would make 12, so it is cut; c3 still fits at 9.
    expect(rows.map((row) => [row.key, row.decision, row.cumulativeUsd])).toEqual([
      ['r1', 'run', 2],
      ['r2', 'run', 3],
      ['c1', 'run', 8],
      ['c2', 'cut', 8],
      ['c3', 'run', 9],
    ])
  })

  it('carries the campaign’s OWASP ids and priority', () => {
    expect(rows[2]).toMatchObject({ category: 'prompt_injection', subcategory: 'direct', owaspIds: ['LLM01'], priority: 0.9 })
  })

  it('works with no plan: operator requests only', () => {
    expect(planTonightRows([request('r1', 12), request('r2', 1)], [], 10).map((row) => row.decision)).toEqual([
      'cut',
      'run',
    ])
  })
})

describe('parsePlanCampaigns', () => {
  const planItems = [
    {
      item_id: 'req-1',
      kind: 'operator_request',
      request_id: '00000000-0000-4000-8000-000000000001',
      category: 'prompt_injection',
      seed_case_ids: [],
      max_attempts: 20,
      estimated_cost_usd: 0,
      decision: 'run',
      reason: 'operator rerun',
    },
    {
      item_id: 'cell-data_exfiltration/phi_leakage',
      kind: 'coverage_campaign',
      category: 'data_exfiltration',
      subcategory: 'phi_leakage',
      owasp_ids: ['LLM02', 'A01'],
      priority: 0.82,
      seed_case_ids: ['s1'],
      max_attempts: 20,
      estimated_cost_usd: 6.4,
      decision: 'run',
      reason: 'coverage priority 0.820',
    },
    {
      item_id: 'cell-tool_misuse/parameter_tampering',
      kind: 'coverage_campaign',
      category: 'tool_misuse',
      subcategory: 'parameter_tampering',
      seed_case_ids: [],
      max_attempts: 20,
      estimated_cost_usd: 4.2,
      decision: 'cut',
      reason: 'coverage priority 0.610',
    },
    { item_id: 'broken', kind: 'coverage_campaign' },
  ]

  it('keeps coverage campaigns in plan order; operator items come from the live queue instead', () => {
    const campaigns = parsePlanCampaigns({ items: planItems }, () => [])
    expect(campaigns.map((entry) => entry.itemId)).toEqual([
      'cell-data_exfiltration/phi_leakage',
      'cell-tool_misuse/parameter_tampering',
    ])
    expect(campaigns[0]).toEqual({
      itemId: 'cell-data_exfiltration/phi_leakage',
      category: 'data_exfiltration',
      subcategory: 'phi_leakage',
      owaspIds: ['LLM02', 'A01'],
      priority: 0.82,
      estimatedCostUsd: 6.4,
      maxAttempts: 20,
      reason: 'coverage priority 0.820',
    })
  })

  it('falls back to OWASP ids observed for the cell when the item has none', () => {
    const campaigns = parsePlanCampaigns({ items: planItems }, (category, subcategory) =>
      category === 'tool_misuse' && subcategory === 'parameter_tampering' ? ['LLM06'] : [],
    )
    expect(campaigns[1]?.owaspIds).toEqual(['LLM06'])
  })

  it('returns nothing for a plan without items', () => {
    expect(parsePlanCampaigns(null, () => [])).toEqual([])
    expect(parsePlanCampaigns({ items: 'nope' }, () => [])).toEqual([])
  })
})

describe('parseTonightPlan', () => {
  it('reads the plan header and its campaigns', () => {
    const plan = parseTonightPlan(
      {
        runId: '7',
        scheduledFor: '2026-09-30T06:00:00.000Z',
        plan: {
          produced_at: '2026-09-29T21:00:00.000Z',
          target_version: 'copilot@c1f011e',
          budget_usd: 25,
          notes: ['Operator skipped category denial_of_service tonight.'],
          items: [],
        },
      },
      () => [],
    )
    expect(plan).toEqual({
      runId: '7',
      scheduledFor: '2026-09-30T06:00:00.000Z',
      producedAt: '2026-09-29T21:00:00.000Z',
      targetVersion: 'copilot@c1f011e',
      budgetUsd: 25,
      campaigns: [],
      notes: ['Operator skipped category denial_of_service tonight.'],
    })
  })

  it('is null for a plan that is not a NightlyPlan', () => {
    expect(parseTonightPlan({ runId: '7', scheduledFor: '2026-09-30T06:00:00.000Z', plan: { scope: { kind: 'queue' } } }, () => [])).toBeNull()
  })
})
