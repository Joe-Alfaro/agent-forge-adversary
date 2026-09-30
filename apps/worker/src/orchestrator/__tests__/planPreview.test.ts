import { describe, expect, it } from 'vitest'

import { DEFAULT_WEIGHTS } from '../priority.js'
import { readPlanPreviewConfig } from '../planPreview.js'

describe('readPlanPreviewConfig', () => {
  it('defaults the envelope to the dashboard default and the window to 01:00 CT', () => {
    expect(readPlanPreviewConfig({})).toEqual({
      budgetUsd: 25,
      weights: DEFAULT_WEIGHTS,
      costPerAttemptUsd: 0.05,
      maxAttemptsPerCampaign: 4,
      topK: 6,
      window: { hour: 1, timeZone: 'America/Chicago' },
    })
  })

  it('reads the envelope, window, and planner knobs from env', () => {
    const config = readPlanPreviewConfig({
      NIGHTLY_BUDGET_USD: '3.5',
      NIGHTLY_HOUR: '2',
      NIGHTLY_TZ: 'UTC',
      PLAN_TOP_K: '3',
      PLAN_MAX_ATTEMPTS: '5',
      PLAN_COST_PER_ATTEMPT_USD: '0.1',
      PLAN_TARGET_VERSION: 'copilot@abc',
    })
    expect(config).toMatchObject({
      budgetUsd: 3.5,
      topK: 3,
      maxAttemptsPerCampaign: 5,
      costPerAttemptUsd: 0.1,
      window: { hour: 2, timeZone: 'UTC' },
      targetVersion: 'copilot@abc',
    })
  })

  it('rejects a malformed envelope', () => {
    expect(() => readPlanPreviewConfig({ NIGHTLY_BUDGET_USD: 'lots' })).toThrow(/NIGHTLY_BUDGET_USD/)
    expect(() => readPlanPreviewConfig({ PLAN_TOP_K: '2.5' })).toThrow(/PLAN_TOP_K/)
  })
})
