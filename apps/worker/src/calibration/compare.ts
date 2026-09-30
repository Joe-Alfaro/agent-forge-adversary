import type { AttackTranscript, DetectorResult, VerdictOutcome } from '@agentforge/contracts'

import { runDetectors } from '../detectors/index.js'
import { judgeAttempt, type JudgeClock, type JudgeModel } from '../judge/index.js'
import { toTranscript, type GroundTruthCase, type GroundTruthKind, type GroundTruthSet } from './groundTruth.js'

/**
 * Judge model comparison over the calibration set: the question it answers is
 * "can a cheaper model run stage 2 without making verdicts worse?" (KEY_METRICS
 * M1, M2; Architecture 8.3, 12).
 *
 * Everything except the stage-2 model is held constant. Detectors run once per
 * case and the same `DetectorResult` is handed to every model, so stage 1 is
 * identical by construction; the frozen rubric comes from `rubricFor`, which the
 * Judge already stamps into each verdict. Only `model.judge` differs.
 */

export interface TokenUsage {
  input_tokens: number
  output_tokens: number
}

/** A stage-2 model; `lastUsage` is read after each call to price it. */
export type ComparableJudgeModel = JudgeModel & { lastUsage?: TokenUsage | undefined }

/** Anthropic first-party rates, USD per million tokens (Architecture 12, as of 2026-09-25). */
const PRICES_PER_MTOK: Readonly<Record<string, { input: number; output: number }>> = {
  'claude-sonnet-5-5': { input: 2, output: 10 },
  'claude-haiku-4-5': { input: 1, output: 5 },
  'claude-opus-5-5': { input: 4, output: 20 },
}

export function estimateCallCostUsd(modelId: string, usage: TokenUsage): number {
  const price = PRICES_PER_MTOK[modelId]
  if (price === undefined) {
    throw new Error(`No price on record for model "${modelId}"; add it before comparing it.`)
  }
  return (usage.input_tokens * price.input + usage.output_tokens * price.output) / 1_000_000
}

export interface CaseOutcome {
  id: string
  category: string
  kind: GroundTruthKind
  label: VerdictOutcome
  outcome?: VerdictOutcome
  confidence?: number
  stage?: 'detector' | 'llm_primary'
  needs_review?: boolean
  correct?: boolean
  cost_usd: number
  skipped?: boolean
  error?: string
}

export interface ModelMetrics {
  /** Judged cases (skipped cases are excluded, not counted as wrong). */
  total: number
  agree: number
  agreement: number | null
  /** M1: clean controls judged `success` or `partial`. Target zero. */
  control_total: number
  control_false_positives: number
  control_fp_rate: number | null
  /** Labeled `fail`, judged `success`/`partial` (controls included). */
  false_positives: number
  /** Labeled `success`/`partial`, judged `fail`. */
  false_negatives: number
  needs_review: number
  skipped: number
  by_category: Record<string, { total: number; agree: number }>
  llm_calls: number
  total_cost_usd: number
  cost_per_llm_verdict_usd: number | null
}

export interface ModelRun {
  model: string
  cases: CaseOutcome[]
  metrics: ModelMetrics
}

export interface Disagreement {
  id: string
  category: string
  kind: GroundTruthKind
  label: VerdictOutcome
  outcomes: Record<string, VerdictOutcome>
}

export interface ComparisonResult {
  set_version: string
  generated_at: string
  case_count: number
  models: ModelRun[]
  /** Cases the compared models judged differently (the Sonnet-vs-Haiku list). */
  disagreements: Disagreement[]
  total_cost_usd: number
  spend_cap_usd: number | null
  capped: boolean
}

export interface CompareParams {
  set: GroundTruthSet
  models: ComparableJudgeModel[]
  clock: JudgeClock
  /** Stop calling models once the next call's estimate would exceed this. */
  spendCapUsd?: number
  /** Pre-call token estimate used for the spend cap; omitted, the cap is checked after each call only. */
  estimateUsage?: (transcript: AttackTranscript, c: GroundTruthCase) => TokenUsage
  targetVersion?: string
}

interface PreparedCase {
  c: GroundTruthCase
  transcript: AttackTranscript
  detectorResult: DetectorResult
}

export async function compareJudgeModels(params: CompareParams): Promise<ComparisonResult> {
  const { set, models, clock } = params
  const cap = params.spendCapUsd ?? null
  const targetVersion = params.targetVersion ?? `copilot@${set.version}`

  const prepared: PreparedCase[] = set.cases.map((c) => {
    const transcript = toTranscript(c, targetVersion)
    return { c, transcript, detectorResult: runDetectors(transcript, c.detector_context, clock) }
  })

  const outcomes = new Map<string, CaseOutcome[]>(models.map((m) => [m.id, []]))
  const spend = { total: 0, capped: false }

  // Sequential, case-major: paid calls stay under the spend cap one at a time,
  // and when the cap bites every model has judged the same cases, so a capped
  // run is still a like-for-like comparison.
  const jobs = prepared.flatMap((p) => models.map((model) => ({ p, model })))
  await jobs.reduce(async (previous, { p, model }) => {
    await previous
    const result = await judgeOne(p, model, params, cap, spend, clock)
    outcomes.get(model.id)!.push(result)
  }, Promise.resolve())

  const runs: ModelRun[] = models.map((m) => {
    const cases = outcomes.get(m.id)!
    return { model: m.id, cases, metrics: summarize(cases) }
  })

  return {
    set_version: set.version,
    generated_at: new Date(clock.now()).toISOString(),
    case_count: set.cases.length,
    models: runs,
    disagreements: findDisagreements(set.cases, runs),
    total_cost_usd: spend.total,
    spend_cap_usd: cap,
    capped: spend.capped,
  }
}

async function judgeOne(
  p: PreparedCase,
  model: ComparableJudgeModel,
  params: CompareParams,
  cap: number | null,
  spend: { total: number; capped: boolean },
  clock: JudgeClock,
): Promise<CaseOutcome> {
  const { c, transcript, detectorResult } = p
  const base: CaseOutcome = { id: c.id, category: c.category, kind: c.kind, label: c.label, cost_usd: 0 }
  const needsModel = !detectorResult.any_fired

  if (needsModel && cap !== null) {
    const estimate =
      params.estimateUsage === undefined ? 0 : estimateCallCostUsd(model.id, params.estimateUsage(transcript, c))
    if (spend.total + estimate > cap) {
      spend.capped = true
      return { ...base, skipped: true, error: `spend cap $${cap.toFixed(2)} reached` }
    }
  }

  try {
    const verdict = await judgeAttempt({ transcript, detectorResult, category: c.category, model, clock })
    const cost = needsModel && model.lastUsage !== undefined ? estimateCallCostUsd(model.id, model.lastUsage) : 0
    spend.total += cost
    return {
      ...base,
      outcome: verdict.outcome,
      confidence: verdict.confidence,
      stage: verdict.stage === 'detector' ? 'detector' : 'llm_primary',
      needs_review: verdict.needs_review,
      correct: verdict.outcome === c.label,
      cost_usd: cost,
    }
  } catch (error: unknown) {
    return { ...base, skipped: true, error: error instanceof Error ? error.message : String(error) }
  }
}

function summarize(cases: CaseOutcome[]): ModelMetrics {
  const judged = cases.filter((c) => c.skipped !== true && c.outcome !== undefined)
  const flagged = (c: CaseOutcome) => c.outcome === 'success' || c.outcome === 'partial'
  const controls = judged.filter((c) => c.kind === 'clean_control')
  const controlFps = controls.filter(flagged).length
  const agree = judged.filter((c) => c.correct === true).length
  const llm = judged.filter((c) => c.stage === 'llm_primary')
  const totalCost = judged.reduce((sum, c) => sum + c.cost_usd, 0)

  const byCategory = judged.reduce<Record<string, { total: number; agree: number }>>((acc, c) => {
    const entry = acc[c.category] ?? { total: 0, agree: 0 }
    acc[c.category] = { total: entry.total + 1, agree: entry.agree + (c.correct === true ? 1 : 0) }
    return acc
  }, {})

  return {
    total: judged.length,
    agree,
    agreement: ratio(agree, judged.length),
    control_total: controls.length,
    control_false_positives: controlFps,
    control_fp_rate: ratio(controlFps, controls.length),
    false_positives: judged.filter((c) => c.label === 'fail' && flagged(c)).length,
    false_negatives: judged.filter((c) => c.label !== 'fail' && c.outcome === 'fail').length,
    needs_review: judged.filter((c) => c.needs_review === true).length,
    skipped: cases.length - judged.length,
    by_category: byCategory,
    llm_calls: llm.length,
    total_cost_usd: totalCost,
    cost_per_llm_verdict_usd: llm.length === 0 ? null : totalCost / llm.length,
  }
}

function findDisagreements(cases: GroundTruthCase[], runs: ModelRun[]): Disagreement[] {
  if (runs.length < 2) {
    return []
  }
  return cases.flatMap((c, i) => {
    const outcomes = runs.reduce<Record<string, VerdictOutcome>>((acc, run) => {
      const outcome = run.cases[i]?.outcome
      if (outcome !== undefined) {
        acc[run.model] = outcome
      }
      return acc
    }, {})
    const distinct = new Set(Object.values(outcomes))
    if (Object.keys(outcomes).length < 2 || distinct.size < 2) {
      return []
    }
    return [{ id: c.id, category: c.category, kind: c.kind, label: c.label, outcomes }]
  })
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator
}
