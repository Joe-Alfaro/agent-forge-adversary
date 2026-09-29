/**
 * Live seed-suite run against the DEPLOYED Co-Pilot: for a capped selection of
 * seeds (one per category by default, ≥3 categories), it drives the Target
 * Adapter, runs the deterministic detectors, and judges with stages 1-2, then
 * writes a redacted results file to evals/results/.
 *
 * Secrets come only from the operator env file (AGENTFORGE_ENV_FILE, default
 * ~/.config/agentforge/.env). No secret value or minted token is ever printed or
 * written — tokens are redacted from the stored transcripts.
 *
 * Usage (after `npm run build`):
 *   node apps/worker/dist/scripts/liveEvalRun.js
 * Env knobs: LIVE_MAX_CASES (default 8), LIVE_CASES_PER_CATEGORY (default 1),
 * LIVE_SPEND_CAP_USD (default 1.00).
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import Anthropic from '@anthropic-ai/sdk'

import {
  Allowlist,
  CopilotClient,
  HttpTransport,
  TargetAdapter,
  type AttachedDocument,
  type PatientBundle,
} from '../target/index.js'
import { runDetectors, type DetectorContext } from '../detectors/index.js'
import { AnthropicJudgeModel, judgeAttempt, rubricFor } from '../judge/index.js'
import { loadEvalSuite, type EvalCase } from '../evals/index.js'
import { createTracer } from '../observability/index.js'
import { loadAgentforgeEnv } from './loadEnv.js'

const ROLE_USER_IDS: Readonly<Record<string, number>> = { clinician: 1, nurse: 2 }
// Rough per-MTok rates for a cost ESTIMATE only (USD): the Co-Pilot's own model
// is unknown, so Sonnet-class rates are used as a stand-in; the judge is Sonnet.
const TARGET_RATE = { input: 3 / 1_000_000, output: 15 / 1_000_000 }
const JUDGE_EST_PER_CASE_USD = 0.008

function syntheticBundle(pid: number): PatientBundle {
  return {
    pid,
    correlation_id: `live-${Date.now()}`,
    retrieved_at: new Date().toISOString(),
    sections: {
      demographics: {
        status: 'ok',
        count: 1,
        records: [{ _source: { table: 'patient_data', row_id: pid }, fname: 'Test', lname: 'Patient', DOB: '1970-01-01' }],
      },
      medications: {
        status: 'ok',
        count: 1,
        records: [{ _source: { table: 'lists', row_id: 1 }, title: 'lisinopril 10mg', comments: 'daily' }],
      },
    },
    recorded_absences: [],
    denied_sections: [],
  }
}

function selectCases(suite: EvalCase[], perCategory: number, maxCases: number): EvalCase[] {
  const counts = new Map<string, number>()
  const chosen: EvalCase[] = []
  for (const c of suite) {
    if (chosen.length >= maxCases) break
    if (rubricFor(c.category) === undefined) continue
    const n = counts.get(c.category) ?? 0
    if (n >= perCategory) continue
    counts.set(c.category, n + 1)
    chosen.push(c)
  }
  return chosen
}

function toDocuments(seed: EvalCase, turnIndex: number): AttachedDocument[] {
  const turn = seed.turns[turnIndex]
  if (turn?.attachments === undefined) return []
  return turn.attachments.map((a, j) => ({
    document_id: `${seed.id}-doc${j}`,
    doc_type: a.doc_type === 'intake_form' ? 'intake_form' : 'lab_pdf',
    file_base64: Buffer.from(a.injected_text ?? 'synthetic document', 'utf8').toString('base64'),
  }))
}

function redact(json: string, secrets: string[]): string {
  let out = json
  for (const s of secrets) {
    if (s && s.length >= 8) {
      out = out.split(s).join('[REDACTED]')
    }
  }
  return out
}

async function main(): Promise<void> {
  const envFile = loadAgentforgeEnv()
  console.log(envFile === null ? 'No AgentForge env file found.' : `Loaded env from ${envFile}`)

  const copilotBase = process.env.COPILOT_BASE_URL ?? 'https://copilot-evidence-production.up.railway.app/'
  const tokenSecret = process.env.COPILOT_TOKEN_SECRET ?? ''
  const judgeKey = process.env.ANTHROPIC_API_KEY_JUDGE ?? process.env.ANTHROPIC_API_KEY ?? ''
  if (tokenSecret === '') {
    throw new Error('COPILOT_TOKEN_SECRET is not set in the env file')
  }
  if (judgeKey === '') {
    throw new Error('ANTHROPIC_API_KEY_JUDGE is not set in the env file')
  }

  const perCategory = Number(process.env.LIVE_CASES_PER_CATEGORY ?? '1')
  const maxCases = Number(process.env.LIVE_MAX_CASES ?? '8')
  const capUsd = Number(process.env.LIVE_SPEND_CAP_USD ?? '1.00')

  const clock = { now: () => Date.now(), randomUUID: () => crypto.randomUUID() }
  const transport = new HttpTransport(
    new Allowlist([copilotBase]),
    (url, init) => fetch(url, init),
    { now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)), random: () => Math.random() },
    { rpm: 20, concurrency: 1, maxRetries: 5, backoffBaseMs: 500, backoffMaxMs: 30_000 },
  )
  const copilot = new CopilotClient(transport, { baseUrl: copilotBase, tokenSecret, roleUserIds: ROLE_USER_IDS }, clock)
  const adapter = new TargetAdapter({ copilot, clock, defaultTokenCeiling: 100_000 })
  const judgeModel = new AnthropicJudgeModel({ client: new Anthropic({ apiKey: judgeKey }) })

  const version = await adapter.getVersion()
  const buildCommit = version.includes('@') ? version.split('@')[1]! : version
  console.log(`Target version: ${version}`)

  // Auth preflight — one benign call, no judge, to fail fast on a bad secret.
  const probeSession = copilot.newSession('clinician', syntheticBundle(1))
  const probe = await copilot.answer(probeSession, 'What are the current medications for this patient?', [], `preflight-${Date.now()}`)
  if (probe.httpStatus === 401) {
    console.error(`AUTH FAILED: POST /answer returned 401 with the provided COPILOT_TOKEN_SECRET.`)
    console.error(`Exact response body: ${JSON.stringify(probe.body)}`)
    console.error('Stopping before any judge call. The secret likely does not match the deployed Co-Pilot.')
    process.exitCode = 2
    return
  }
  console.log(`Auth preflight OK (http ${probe.httpStatus}).`)

  const suite = loadEvalSuite(seedDir())
  const cases = selectCases(suite, perCategory, maxCases)
  console.log(`Running ${cases.length} cases across ${new Set(cases.map((c) => c.category)).size} categories (cap $${capUsd}).`)

  const tracer = createTracer(process.env, { secrets: [tokenSecret, judgeKey] })
  const trace = tracer.startTrace({ name: `live-eval ${version}`, buildCommit, metadata: { cases: cases.length } })

  const sessionTokens: string[] = [probeSession.token]
  const results: unknown[] = []
  const byCategory: Record<string, { attempts: number; success: number; partial: number; fail: number; needs_review: number }> = {}
  let targetInput = 0
  let targetOutput = 0
  let judgeCalls = 0

  for (const seed of cases) {
    const runningEstimate = targetInput * TARGET_RATE.input + targetOutput * TARGET_RATE.output + judgeCalls * JUDGE_EST_PER_CASE_USD
    if (runningEstimate >= capUsd) {
      console.log(`Spend cap reached (~$${runningEstimate.toFixed(3)}); stopping before ${seed.id}.`)
      break
    }

    const session = copilot.newSession(seed.session_role in ROLE_USER_IDS ? seed.session_role : 'clinician', syntheticBundle(1))
    sessionTokens.push(session.token)
    const transcript = await adapter.runAttempt({
      campaignId: crypto.randomUUID(),
      traceId: `live-${seed.id}-${Date.now()}`,
      session,
      turns: seed.turns.map((t, i) => ({ message: t.message, documents: toDocuments(seed, i) })),
    })
    targetInput += transcript.totals.input_tokens
    targetOutput += transcript.totals.output_tokens

    const context: DetectorContext = {
      unauthorizedCanaries: [],
      contextPatientId: 1,
      foreignIdentifiers: [],
      allowedTools: ['intake-extractor', 'evidence-retriever'],
      maxToolCalls: 3,
    }
    trace.span({
      name: `target:${seed.id}`,
      input: { category: seed.category, subcategory: seed.subcategory, turns: seed.turns.map((t) => t.message) },
      output: { http_status: transcript.turns.map((t) => t.http_status), tool_sequence: transcript.turns.flatMap((t) => t.tool_sequence ?? []), degraded: transcript.turns.map((t) => t.degraded) },
      metadata: { attempt_id: transcript.attempt_id, transcript_message_id: transcript.message_id, target_tokens: transcript.totals },
    })

    const detectorResult = runDetectors(transcript, context, clock)
    trace.span({
      name: `detectors:${seed.id}`,
      input: { consumes: transcript.message_id, attempt_id: transcript.attempt_id },
      output: { results: detectorResult.results.map((r) => ({ detector: r.detector, status: r.status })), any_fired: detectorResult.any_fired },
      metadata: { produces: detectorResult.message_id },
    })

    const verdict = await judgeAttempt({ transcript, detectorResult, category: seed.category, model: judgeModel, clock })
    judgeCalls += 1
    trace.generation({
      name: `judge:${seed.category}`,
      model: judgeModel.id,
      input: { category: seed.category, rubric_version: verdict.rubric_version, consumes: [transcript.message_id, detectorResult.message_id] },
      output: { outcome: verdict.outcome, confidence: verdict.confidence, stage: verdict.stage, needs_review: verdict.needs_review },
      ...(judgeModel.lastUsage === undefined ? {} : { usage: { input: judgeModel.lastUsage.input_tokens, output: judgeModel.lastUsage.output_tokens } }),
      metadata: { produces: verdict.message_id, rubric_version: verdict.rubric_version, stage: verdict.stage },
    })

    const bucket = byCategory[seed.category] ?? { attempts: 0, success: 0, partial: 0, fail: 0, needs_review: 0 }
    bucket.attempts += 1
    bucket[verdict.outcome] += 1
    if (verdict.needs_review) bucket.needs_review += 1
    byCategory[seed.category] = bucket

    results.push({
      id: seed.id,
      category: seed.category,
      subcategory: seed.subcategory,
      http_status: transcript.turns.map((t) => t.http_status),
      outcome: verdict.outcome,
      confidence: verdict.confidence,
      stage: verdict.stage,
      needs_review: verdict.needs_review,
      rubric_version: verdict.rubric_version,
      judge_model: verdict.judge_model,
      tool_sequence: transcript.turns.flatMap((t) => t.tool_sequence ?? []),
      detectors: detectorResult.results.map((r) => ({ detector: r.detector, status: r.status })),
      transcript,
    })
    console.log(`  ${seed.id} [${seed.category}/${seed.subcategory}] -> ${verdict.outcome} (conf ${verdict.confidence}${verdict.needs_review ? ', needs_review' : ''})`)
  }

  const traceUrl = trace.url()
  await tracer.flush()
  await tracer.shutdown()

  const targetUsd = targetInput * TARGET_RATE.input + targetOutput * TARGET_RATE.output
  const judgeUsd = judgeCalls * JUDGE_EST_PER_CASE_USD
  const summary = {
    generated_at: new Date().toISOString(),
    target: { name: 'copilot', base_url: copilotBase, version, build_commit: buildCommit },
    ...(traceUrl === null ? {} : { trace_url: traceUrl }),
    spend_estimate_usd: {
      target: Number(targetUsd.toFixed(4)),
      judge: Number(judgeUsd.toFixed(4)),
      total: Number((targetUsd + judgeUsd).toFixed(4)),
      cap: capUsd,
      note: 'estimate; target model/rate unknown, Sonnet-class rates assumed; judge is a flat per-call estimate',
    },
    target_tokens: { input: targetInput, output: targetOutput },
    totals: { cases: results.length, by_category: byCategory },
    cases: results,
  }

  const date = new Date().toISOString().slice(0, 10)
  const outDir = join(seedResultsDir())
  mkdirSync(outDir, { recursive: true })
  const outPath = join(outDir, `${date}-copilot-${buildCommit}.json`)
  const serialized = redact(JSON.stringify(summary, null, 2), [...sessionTokens, tokenSecret, judgeKey])
  writeFileSync(outPath, `${serialized}\n`, 'utf8')

  console.log('\n=== headline ===')
  console.log(`target ${version}; ${results.length} cases; est spend $${(targetUsd + judgeUsd).toFixed(3)} (cap $${capUsd})`)
  Object.entries(byCategory).forEach(([cat, b]) =>
    console.log(`  ${cat}: ${b.attempts} attempts, ${b.success}S/${b.partial}P/${b.fail}F, needs_review ${b.needs_review}`),
  )
  console.log(`results written to ${outPath}`)
  if (traceUrl !== null) {
    console.log(`trace: ${traceUrl}`)
  }
}

function here(): string {
  return dirname(fileURLToPath(import.meta.url))
}
function seedDir(): string {
  // dist/scripts -> repo root -> evals/seeds
  return join(here(), '..', '..', '..', '..', 'evals', 'seeds')
}
function seedResultsDir(): string {
  return join(here(), '..', '..', '..', '..', 'evals', 'results')
}

main().catch((error: unknown) => {
  console.error('live-eval-run failed:', error instanceof Error ? error.message : error)
  process.exitCode = 1
})
