import { describe, expect, it } from 'vitest'

import { validateVerdict, type DetectorResult } from '@agentforge/contracts'

import { judgeAttempt } from '../judge.js'
import { rubricFor } from '../rubric.js'
import type { JudgeClock, JudgeModel, LlmJudgeVerdict } from '../types.js'
import { transcriptFixture } from '../../detectors/__tests__/fixtures.js'

const clock: JudgeClock = {
  now: () => 1_800_000_000_000,
  randomUUID: () => '44444444-4444-4444-8444-444444444444',
}

function detectorResult(overrides: Partial<DetectorResult> = {}): DetectorResult {
  return {
    schema_version: '1',
    message_id: '55555555-5555-4555-8555-555555555555',
    campaign_id: '22222222-2222-4222-8222-222222222222',
    trace_id: 'trace-abc',
    attempt_id: '33333333-3333-4333-8333-333333333333',
    produced_by: 'detectors',
    produced_at: '2026-09-29T01:00:01.000Z',
    target_version: 'copilot@c1f011e',
    results: [],
    any_fired: false,
    ...overrides,
  }
}

function stubModel(verdict: LlmJudgeVerdict, id = 'claude-sonnet-5-5'): JudgeModel & { calls: number } {
  return {
    id,
    calls: 0,
    async judge() {
      this.calls += 1
      return verdict
    },
  }
}

const transcript = transcriptFixture([{ target_response: { answer: 'ok' } }])

describe('judgeAttempt — stage 1 (detectors authoritative)', () => {
  it('returns a deterministic success without calling the model when an authoritative detector fired', async () => {
    const model = stubModel({ outcome: 'fail', confidence: 0, evidence: [] })
    const det = detectorResult({
      any_fired: true,
      results: [
        {
          detector: 'phi_canary',
          status: 'fired',
          category: 'data_exfiltration',
          authoritative: true,
          evidence: [{ ref: 'canary:MRN-CANARY-8842', note: 'leaked' }],
        },
      ],
    })

    const verdict = await judgeAttempt({ transcript, detectorResult: det, category: 'phi_exfiltration', model, clock })
    expect(validateVerdict(verdict).valid).toBe(true)
    expect(verdict.outcome).toBe('success')
    expect(verdict.confidence).toBe(1)
    expect(verdict.stage).toBe('detector')
    expect(verdict.needs_review).toBe(false)
    expect(verdict.evidence[0]?.kind).toBe('detector_hit')
    expect(model.calls).toBe(0)
  })
})

describe('judgeAttempt — stage 2 (LLM rubric)', () => {
  it('uses the frozen rubric version and records the judge model on an llm_primary verdict', async () => {
    const model = stubModel({ outcome: 'fail', confidence: 0.9, evidence: [{ quote: 'correctly refused' }] })
    const verdict = await judgeAttempt({ transcript, detectorResult: detectorResult(), category: 'prompt_injection', model, clock })
    expect(verdict.stage).toBe('llm_primary')
    expect(verdict.outcome).toBe('fail')
    expect(verdict.judge_model).toBe('claude-sonnet-5-5')
    expect(verdict.rubric_version).toBe(rubricFor('prompt_injection')?.version)
    expect(model.calls).toBe(1)
  })

  it('marks an LLM-only success as needs_review (no authoritative detector corroborated it)', async () => {
    const model = stubModel({ outcome: 'success', confidence: 0.95, evidence: [{ quote: 'system prompt: you are…' }] })
    const verdict = await judgeAttempt({ transcript, detectorResult: detectorResult(), category: 'prompt_injection', model, clock })
    expect(verdict.outcome).toBe('success')
    expect(verdict.needs_review).toBe(true)
    expect(verdict.evidence[0]?.kind).toBe('quoted_span')
  })

  it('does not flag a confident fail for review', async () => {
    const model = stubModel({ outcome: 'fail', confidence: 0.9, evidence: [] })
    const verdict = await judgeAttempt({ transcript, detectorResult: detectorResult(), category: 'prompt_injection', model, clock })
    expect(verdict.needs_review).toBe(false)
  })

  it('clamps an out-of-range confidence', async () => {
    const model = stubModel({ outcome: 'partial', confidence: 1.7, evidence: [] })
    const verdict = await judgeAttempt({ transcript, detectorResult: detectorResult(), category: 'prompt_injection', model, clock })
    expect(verdict.confidence).toBe(1)
  })

  it('throws when no frozen rubric exists for the category', async () => {
    const model = stubModel({ outcome: 'fail', confidence: 0.9, evidence: [] })
    await expect(
      judgeAttempt({ transcript, detectorResult: detectorResult(), category: 'no_such_category', model, clock }),
    ).rejects.toThrow(/No frozen rubric/)
  })
})
