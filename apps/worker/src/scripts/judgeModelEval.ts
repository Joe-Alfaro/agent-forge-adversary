/**
 * Judge model comparison: runs the stage-2 Judge over the hand-labeled
 * calibration set (evals/ground_truth/) once per candidate model, holding the
 * detectors and the frozen rubric constant, and writes a comparison table to
 * evals/results/ (KEY_METRICS M1, M2; Architecture 8.3, 12).
 *
 * Modes:
 *   - default (stub): no API calls. Every stage-2 verdict is a placeholder
 *     `fail`, and cost is MODELED from an estimate of the prompt size, so the
 *     table shows what a real run would cost. Use it to check plumbing.
 *   - `--live`: real calls with ANTHROPIC_API_KEY_JUDGE (from the operator env
 *     file), priced from the usage each response reports, halted before the
 *     spend cap is crossed.
 *
 * Usage (after `npm run build`):
 *   npm run judge:model-eval               # stub
 *   npm run judge:model-eval -- --live     # real, capped
 * Env knobs: JUDGE_EVAL_MODELS (default "claude-sonnet-5-5,claude-haiku-4-5"),
 * JUDGE_EVAL_SPEND_CAP_USD (default 0.50), JUDGE_EVAL_SET (path to a set file).
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'

import Anthropic from '@anthropic-ai/sdk'
import type { AttackTranscript } from '@agentforge/contracts'

import {
  compareJudgeModels,
  loadGroundTruth,
  renderComparisonMarkdown,
  type ComparableJudgeModel,
  type TokenUsage,
} from '../calibration/index.js'
import { AnthropicJudgeModel, type LlmJudgeInput, type LlmJudgeVerdict } from '../judge/index.js'
import { loadAgentforgeEnv } from './loadEnv.js'
import { groundTruthDir, resultsDir } from './paths.js'

const DEFAULT_MODELS = 'claude-sonnet-5-5,claude-haiku-4-5'
const DEFAULT_CAP_USD = 0.5
// System prompt + rubric is ~450 tokens; a structured verdict with a few quotes ~250.
const PROMPT_OVERHEAD_TOKENS = 450
const OUTPUT_TOKENS_ESTIMATE = 250

/** Rough pre-call token estimate (~3.5 chars/token for JSON-heavy text). */
function estimateUsage(transcript: AttackTranscript): TokenUsage {
  const chars = JSON.stringify(transcript.turns).length
  return { input_tokens: PROMPT_OVERHEAD_TOKENS + Math.ceil(chars / 3.5), output_tokens: OUTPUT_TOKENS_ESTIMATE }
}

/** Offline stand-in: a placeholder `fail` with a modeled token usage. */
class StubJudgeModel implements ComparableJudgeModel {
  lastUsage: TokenUsage | undefined
  constructor(readonly id: string) {}

  async judge(input: LlmJudgeInput): Promise<LlmJudgeVerdict> {
    this.lastUsage = estimateUsage(input.transcript)
    return { outcome: 'fail', confidence: 0, evidence: [{ quote: '', note: 'stub mode — not a real verdict' }] }
  }
}

async function main(): Promise<void> {
  const live = process.argv.includes('--live')
  const envFile = loadAgentforgeEnv()
  console.log(envFile === null ? 'No AgentForge env file found; using existing environment.' : `Loaded env from ${envFile}`)

  const modelIds = (process.env.JUDGE_EVAL_MODELS ?? DEFAULT_MODELS).split(',').map((m) => m.trim()).filter(Boolean)
  const cap = Number(process.env.JUDGE_EVAL_SPEND_CAP_USD ?? DEFAULT_CAP_USD)
  const setPath = process.env.JUDGE_EVAL_SET ?? join(groundTruthDir(), 'judge_calibration_v1.json')
  const set = loadGroundTruth(setPath)

  const models = live ? liveModels(modelIds) : modelIds.map((id) => new StubJudgeModel(id))
  console.log(`Mode: ${live ? 'LIVE' : 'stub (no API calls; modeled cost)'} · models: ${modelIds.join(', ')} · ${set.cases.length} cases · cap $${cap.toFixed(2)}`)

  const clock = { now: () => Date.now(), randomUUID: () => crypto.randomUUID() }
  const result = await compareJudgeModels({
    set,
    models,
    clock,
    spendCapUsd: cap,
    estimateUsage: (transcript) => estimateUsage(transcript),
  })

  const mode = live ? 'live' : 'stub'
  const markdown = renderComparisonMarkdown(result, { mode: live ? 'live' : 'stub — outcomes are placeholders, cost is modeled' })
  const stem = `judge-model-eval-${result.generated_at.slice(0, 10)}-${mode}`
  mkdirSync(resultsDir(), { recursive: true })
  writeFileSync(join(resultsDir(), `${stem}.json`), `${JSON.stringify({ mode, set_path: relative(join(resultsDir(), '..', '..'), setPath), ...result }, null, 2)}\n`)
  writeFileSync(join(resultsDir(), `${stem}.md`), markdown)

  console.log(`\n${markdown}`)
  console.log(`Wrote evals/results/${stem}.json and .md`)
}

function liveModels(modelIds: string[]): ComparableJudgeModel[] {
  // The Judge has its own key so its spend is attributable (Architecture 13.1 #8).
  const apiKey = process.env.ANTHROPIC_API_KEY_JUDGE ?? ''
  if (apiKey === '') {
    throw new Error('--live needs ANTHROPIC_API_KEY_JUDGE (set it in the operator env file).')
  }
  const client = new Anthropic({ apiKey })
  return modelIds.map((model) => new AnthropicJudgeModel({ client, model }))
}

main().catch((error: unknown) => {
  console.error('judge-model-eval failed:', error instanceof Error ? error.message : error)
  process.exitCode = 1
})
