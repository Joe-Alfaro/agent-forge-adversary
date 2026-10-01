import { describe, expect, it } from 'vitest'

import type { JudgeModel } from '../../judge/index.js'
import type { CampaignSeed, VariantTurns } from '../../redteam/index.js'
import { runPlan } from '../run.js'
import { baseParams, fakeAdapter, FakeRepo, plan, transcript } from './fakes.js'

/** A fake model-backed variant generator that reports token usage like ModelVariantGenerator. */
function fakeGenerator(perCall = { inputTokens: 1000, outputTokens: 500 }) {
  const gen = {
    calls: 0,
    usage: { inputTokens: 0, outputTokens: 0 },
    async generate(seed: CampaignSeed, count: number): Promise<VariantTurns[]> {
      gen.calls += 1
      gen.usage.inputTokens += perCall.inputTokens
      gen.usage.outputTokens += perCall.outputTokens
      return Array.from({ length: count }, (_, i) => ({
        family: 'model',
        turns: [`${seed.turns[0]} (model variant ${i})`],
        techniqueTags: ['model_generated'],
      }))
    },
  }
  return gen
}

/** A Co-Pilot that, like the deployed one, reports zero token usage. */
function zeroTokenAdapter() {
  return {
    ...fakeAdapter(),
    async runAttempt(params: { campaignId: string; turns: { message: string }[] }) {
      const t = transcript(params.campaignId, params.turns.map((x) => x.message).join(' '), 'Here are the medications.')
      return {
        ...t,
        turns: t.turns.map((turn) => ({ ...turn, token_usage: { input_tokens: 0, output_tokens: 0 } })),
        totals: { ...t.totals, input_tokens: 0, output_tokens: 0 },
      }
    },
  }
}

describe('model-backed Red Team variants', () => {
  it('runs model variants as attempts and charges their generation to spend and the redteam event', async () => {
    const repo = new FakeRepo()
    const generator = fakeGenerator()
    const p = plan()
    p.items[0] = { ...p.items[0]!, max_attempts: 10 }
    const result = await runPlan(baseParams({ repo, plan: p, variantGenerator: generator, modelVariantsPerSeed: 2 }) as never)

    expect(generator.calls).toBe(1)
    expect(repo.attempts.filter((a) => a.techniqueTags.includes('model')).length).toBe(2)
    // 1000 in / 500 out at $3 / $15 per MTok = $0.0105.
    const redteam = repo.events.filter((e) => e.agent === 'redteam')
    expect(redteam[0]?.costUsd).toBeCloseTo(0.0105, 6)
    const byRole = repo.events.reduce((s, e) => s + e.costUsd, 0)
    expect(result.spendUsd).toBeCloseTo(byRole, 6)
  })

  it('skips model generation once the next call could cross the hard cap', async () => {
    const repo = new FakeRepo()
    const generator = fakeGenerator()
    // Cap below one generation call's worst-case cost: generation is skipped, deterministic attempts still run.
    const result = await runPlan(baseParams({ repo, variantGenerator: generator, modelVariantsPerSeed: 2, spendCapUsd: 0.02 }) as never)
    expect(generator.calls).toBe(0)
    expect(result.spendUsd).toBeLessThanOrEqual(0.02)
  })
})

describe('conservative spend accounting', () => {
  it('charges a per-turn fallback when the target reports zero tokens', async () => {
    const repo = new FakeRepo()
    const result = await runPlan(baseParams({ repo, adapter: zeroTokenAdapter() }) as never)
    const target = repo.events.filter((e) => e.agent === 'target')
    expect(target.length).toBe(result.attempts)
    // One turn per attempt at the $0.15 fallback.
    target.forEach((e) => expect(e.costUsd).toBeCloseTo(0.15, 6))
  })

  it('charges the judge by its reported token usage, never below the flat per-call estimate', async () => {
    const repo = new FakeRepo()
    const usageJudge: JudgeModel & { lastUsage?: { input_tokens: number; output_tokens: number } | undefined } = {
      id: 'claude-sonnet-5-5',
      lastUsage: undefined,
      async judge() {
        usageJudge.lastUsage = { input_tokens: 4000, output_tokens: 400 }
        return { outcome: 'fail', confidence: 0.9, evidence: [] }
      },
    }
    await runPlan(baseParams({ repo, judgeModel: usageJudge }) as never)
    const judge = repo.events.filter((e) => e.agent === 'judge')
    // 4000 in / 400 out at $3 / $15 per MTok = $0.018 (> the $0.008 floor).
    judge.forEach((e) => expect(e.costUsd).toBeCloseTo(0.018, 6))
  })

  it('does not start a campaign whose estimate would cross the hard cap', async () => {
    const repo = new FakeRepo()
    const p = plan()
    p.items = [
      { ...p.items[0]!, item_id: 'a', estimated_cost_usd: 0.05 },
      { ...p.items[0]!, item_id: 'b', estimated_cost_usd: 5 },
    ]
    const result = await runPlan(baseParams({ repo, plan: p, spendCapUsd: 1 }) as never)
    expect(result.status).toBe('aborted')
    expect(result.summary.notes.some((n) => n.includes('b') && n.includes('cap'))).toBe(true)
    expect(repo.campaignUpdates.length).toBe(1)
  })
})
