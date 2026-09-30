import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { validateAttackTranscript } from '@agentforge/contracts'

import { runDetectors } from '../../detectors/index.js'
import { loadEvalSuite } from '../../evals/index.js'
import type { JudgeModel, LlmJudgeInput, LlmJudgeVerdict } from '../../judge/index.js'
import {
  compareJudgeModels,
  estimateCallCostUsd,
  loadGroundTruth,
  parseGroundTruth,
  renderComparisonMarkdown,
  toGroundTruthRow,
  toTranscript,
  type GroundTruthCase,
  type GroundTruthSet,
} from '../index.js'

const REPO_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..', '..', '..')
const GROUND_TRUTH_FILE = join(REPO_ROOT, 'evals', 'ground_truth', 'judge_calibration_v1.json')
const SEED_DIR = join(REPO_ROOT, 'evals', 'seeds')

const clock = { now: () => 1_800_000_000_000, randomUUID: () => '44444444-4444-4444-8444-444444444444' }

function baseCase(overrides: Partial<GroundTruthCase>): GroundTruthCase {
  return {
    id: 'gt-x',
    category: 'prompt_injection',
    kind: 'attack_defended',
    label: 'fail',
    rationale: 'stays in role',
    session_role: 'clinician',
    context_patient_id: 1,
    turns: [{ attacker_message: 'hello', target_response: { claims: [] }, tool_sequence: ['evidence-retriever'] }],
    detector_context: { unauthorizedCanaries: [], foreignIdentifiers: [], allowedTools: ['evidence-retriever'] },
    ...overrides,
  }
}

function set(cases: GroundTruthCase[]): GroundTruthSet {
  return { version: 'test@1', labeled_by: 'tester', labeled_at: '2026-09-30', cases }
}

/** A fake stage-2 model that answers from a per-case table, keyed by the transcript's attempt id. */
function tableModel(id: string, answers: Record<string, LlmJudgeVerdict['outcome']>): JudgeModel & { calls: string[] } {
  const calls: string[] = []
  return {
    id,
    calls,
    async judge(input: LlmJudgeInput) {
      const caseId = input.transcript.trace_id.replace(/^calibration-/, '')
      calls.push(caseId)
      return { outcome: answers[caseId] ?? 'fail', confidence: 0.9, evidence: [] }
    },
  }
}

describe('ground-truth set (evals/ground_truth)', () => {
  const gt = loadGroundTruth(GROUND_TRUTH_FILE)

  it('is small enough for a cheap paid run and big enough to mean something', () => {
    expect(gt.cases.length).toBeGreaterThanOrEqual(10)
    expect(gt.cases.length).toBeLessThanOrEqual(20)
  })

  it('has unique ids, a rationale on every case, and a frozen rubric for every category', () => {
    const ids = gt.cases.map((c) => c.id)
    expect(new Set(ids).size).toBe(ids.length)
    gt.cases.forEach((c) => expect(c.rationale.length).toBeGreaterThan(20))
  })

  it('covers clean controls, defended attacks, and successful attacks', () => {
    const kinds = new Set(gt.cases.map((c) => c.kind))
    expect(kinds).toEqual(new Set(['clean_control', 'attack_defended', 'attack_success', 'detector_success']))
    expect(gt.cases.filter((c) => c.kind === 'clean_control').length).toBeGreaterThanOrEqual(4)
  })

  it('labels every clean control fail (a control can never be a finding)', () => {
    gt.cases.filter((c) => c.kind === 'clean_control').forEach((c) => expect(c.label).toBe('fail'))
  })

  it('builds a schema-valid AttackTranscript for every case', () => {
    gt.cases.forEach((c) => {
      const check = validateAttackTranscript(toTranscript(c, 'copilot@calibration'))
      expect(check.errors, c.id).toEqual([])
    })
  })

  it('derives from seed cases that actually exist', () => {
    const seedIds = new Set(loadEvalSuite(SEED_DIR).map((s) => s.id))
    gt.cases
      .filter((c) => c.source_seed_id !== undefined)
      .forEach((c) => expect(seedIds.has(c.source_seed_id!), `${c.id} -> ${c.source_seed_id}`).toBe(true))
  })

  it('routes to stage 1 exactly the cases labeled detector_success', () => {
    gt.cases.forEach((c) => {
      const result = runDetectors(toTranscript(c, 'copilot@calibration'), c.detector_context, clock)
      expect(result.any_fired, c.id).toBe(c.kind === 'detector_success')
    })
  })

  it('maps each case onto a ground_truth table row (Architecture 14.3)', () => {
    const [first] = gt.cases
    const row = toGroundTruthRow(first!, gt)
    expect(row).toMatchObject({ label: first!.label, category: first!.category, labeled_by: gt.labeled_by })
    expect(row.transcript.schema_version).toBe('1')
  })
})

describe('parseGroundTruth', () => {
  it('rejects a clean control labeled as anything but fail', () => {
    const bad = set([baseCase({ kind: 'clean_control', label: 'partial' })])
    expect(() => parseGroundTruth(bad)).toThrow(/clean control/)
  })

  it('rejects a category with no frozen rubric', () => {
    expect(() => parseGroundTruth(set([baseCase({ category: 'nope' })]))).toThrow(/rubric/)
  })

  it('rejects duplicate ids', () => {
    expect(() => parseGroundTruth(set([baseCase({}), baseCase({})]))).toThrow(/duplicate/)
  })
})

describe('estimateCallCostUsd', () => {
  it('prices Sonnet 5.5 at $2/$10 and Haiku 4.5 at $1/$5 per MTok', () => {
    expect(estimateCallCostUsd('claude-sonnet-5-5', { input_tokens: 1_000_000, output_tokens: 100_000 })).toBeCloseTo(3)
    expect(estimateCallCostUsd('claude-haiku-4-5', { input_tokens: 1_000_000, output_tokens: 100_000 })).toBeCloseTo(1.5)
  })

  it('refuses to guess a price for an unknown model', () => {
    expect(() => estimateCallCostUsd('mystery', { input_tokens: 1, output_tokens: 1 })).toThrow(/price/)
  })
})

describe('compareJudgeModels', () => {
  const cases = [
    baseCase({ id: 'ctrl-1', kind: 'clean_control', label: 'fail' }),
    baseCase({ id: 'ctrl-2', kind: 'clean_control', label: 'fail', category: 'data_exfiltration' }),
    baseCase({ id: 'atk-ok', kind: 'attack_success', label: 'success' }),
    baseCase({ id: 'atk-def', kind: 'attack_defended', label: 'fail' }),
    baseCase({
      id: 'det',
      kind: 'detector_success',
      label: 'success',
      category: 'tool_misuse',
      turns: [{ attacker_message: 'x', target_response: {}, tool_sequence: ['order-writer'] }],
    }),
  ]

  it('holds stage 1 constant: detector-decided cases never reach either model', async () => {
    const sonnet = tableModel('claude-sonnet-5-5', { 'atk-ok': 'success' })
    const haiku = tableModel('claude-haiku-4-5', { 'atk-ok': 'success' })
    const result = await compareJudgeModels({ set: set(cases), models: [sonnet, haiku], clock })

    expect(sonnet.calls).not.toContain('det')
    expect(haiku.calls).not.toContain('det')
    expect(sonnet.calls.sort()).toEqual(haiku.calls.sort())
    result.models.forEach((m) => {
      const det = m.cases.find((c) => c.id === 'det')
      expect(det).toMatchObject({ stage: 'detector', outcome: 'success', correct: true, cost_usd: 0 })
    })
  })

  it('computes agreement, clean-control false-positive rate (M1), and false negatives per model', async () => {
    const sonnet = tableModel('claude-sonnet-5-5', { 'atk-ok': 'success' })
    // Haiku over-flags one control (a false positive) and misses the real success.
    const haiku = tableModel('claude-haiku-4-5', { 'ctrl-1': 'partial', 'atk-ok': 'fail' })
    const result = await compareJudgeModels({ set: set(cases), models: [sonnet, haiku], clock })

    const [s, h] = result.models
    expect(s!.metrics).toMatchObject({ total: 5, agree: 5, agreement: 1, control_total: 2, control_false_positives: 0, control_fp_rate: 0, false_negatives: 0 })
    expect(h!.metrics).toMatchObject({ total: 5, agree: 3, agreement: 0.6, control_false_positives: 1, control_fp_rate: 0.5, false_negatives: 1 })
    expect(h!.metrics.by_category.prompt_injection).toEqual({ total: 3, agree: 1 })
  })

  it('lists cases where the models disagree with each other', async () => {
    const sonnet = tableModel('claude-sonnet-5-5', { 'atk-ok': 'success' })
    const haiku = tableModel('claude-haiku-4-5', { 'ctrl-1': 'partial', 'atk-ok': 'fail' })
    const result = await compareJudgeModels({ set: set(cases), models: [sonnet, haiku], clock })

    expect(result.disagreements.map((d) => d.id)).toEqual(['ctrl-1', 'atk-ok'])
    expect(result.disagreements[0]).toMatchObject({ label: 'fail', outcomes: { 'claude-sonnet-5-5': 'fail', 'claude-haiku-4-5': 'partial' } })
  })

  it('prices each stage-2 verdict from the usage the model reports', async () => {
    const usage = { input_tokens: 3000, output_tokens: 300 }
    const sonnet = Object.assign(tableModel('claude-sonnet-5-5', {}), { lastUsage: usage })
    const haiku = Object.assign(tableModel('claude-haiku-4-5', {}), { lastUsage: usage })
    const result = await compareJudgeModels({ set: set(cases), models: [sonnet, haiku], clock })

    const [s, h] = result.models
    expect(s!.metrics.llm_calls).toBe(4)
    expect(s!.metrics.cost_per_llm_verdict_usd).toBeCloseTo(0.009)
    expect(h!.metrics.cost_per_llm_verdict_usd).toBeCloseTo(0.0045)
    expect(s!.metrics.total_cost_usd).toBeCloseTo(0.036)
  })

  it('stops calling models once the spend cap would be exceeded, and says so', async () => {
    const usage = { input_tokens: 3000, output_tokens: 300 }
    const sonnet = Object.assign(tableModel('claude-sonnet-5-5', {}), { lastUsage: usage })
    const result = await compareJudgeModels({
      set: set(cases),
      models: [sonnet],
      clock,
      spendCapUsd: 0.02,
      estimateUsage: () => usage,
    })

    expect(sonnet.calls.length).toBe(2)
    expect(result.capped).toBe(true)
    expect(result.total_cost_usd).toBeLessThanOrEqual(0.02)
    expect(result.models[0]!.cases.filter((c) => c.skipped).length).toBe(2)
  })

  it('counts a judge error as a skipped case rather than aborting the run', async () => {
    const flaky: JudgeModel = {
      id: 'claude-haiku-4-5',
      async judge() {
        throw new Error('overloaded')
      },
    }
    const result = await compareJudgeModels({ set: set(cases), models: [flaky], clock })
    const skipped = result.models[0]!.cases.filter((c) => c.skipped)
    expect(skipped.length).toBe(4)
    expect(skipped[0]!.error).toMatch(/overloaded/)
    // Skipped cases are excluded from agreement, not counted as wrong.
    expect(result.models[0]!.metrics.total).toBe(1)
  })
})

describe('renderComparisonMarkdown', () => {
  it('renders the per-model table and the disagreement list', async () => {
    const sonnet = tableModel('claude-sonnet-5-5', { x: 'success' })
    const haiku = tableModel('claude-haiku-4-5', { x: 'fail' })
    const result = await compareJudgeModels({
      set: set([baseCase({ id: 'x', kind: 'attack_success', label: 'success' })]),
      models: [sonnet, haiku],
      clock,
    })
    const md = renderComparisonMarkdown(result)
    expect(md).toMatch(/\| Model \| Agreement \|/)
    expect(md).toMatch(/claude-sonnet-5-5 \| 100\.0% \(1\/1\)/)
    expect(md).toMatch(/claude-haiku-4-5 \| 0\.0% \(0\/1\)/)
    expect(md).toMatch(/## Disagreements/)
    expect(md).toMatch(/`x`/)
  })

  it('lists skipped cases with the reason, so a partial run cannot pass for a full one', async () => {
    const broke: JudgeModel = {
      id: 'claude-haiku-4-5',
      async judge() {
        throw new Error('credit balance is too low')
      },
    }
    const result = await compareJudgeModels({ set: set([baseCase({ id: 'y' })]), models: [broke], clock })
    const md = renderComparisonMarkdown(result)
    expect(md).toMatch(/## Skipped cases/)
    expect(md).toMatch(/claude-haiku-4-5.*`y`.*credit balance is too low/)
  })
})
