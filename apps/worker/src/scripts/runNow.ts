/**
 * "Run now": the on-demand Orchestrator run (ARCHITECTURE 7.0). It drains the
 * operator queue and the coverage matrix into a NightlyPlan, then runs it end to
 * end against the DEPLOYED Co-Pilot, writing attempts/verdicts/exploits/coverage
 * and one nightly_runs row to the configured Postgres so the dashboard reflects
 * it. Spend is bounded by a HARD dollar cap passed explicitly; the run aborts
 * before exceeding it.
 *
 * Secrets come only from the operator env file (AGENTFORGE_ENV_FILE, default
 * ~/.config/agentforge/.env) and DATABASE_URL. Minted tokens and API keys are
 * redacted from stored transcripts and from every trace span.
 *
 * Usage (after `npm run build`):
 *   RUN_SPEND_CAP_USD=3 RUN_CATEGORIES=prompt_injection,data_exfiltration \
 *   DATABASE_URL=postgres://... npm run run:now -w apps/worker
 *
 * Env knobs: RUN_SPEND_CAP_USD (required, hard cap), RUN_CATEGORIES (csv, subset
 * of taxonomy categories), RUN_PER_FAMILY (default 1), RUN_MAX_ATTEMPTS (per
 * campaign, default 4), RUN_TOP_K (default 3), RUN_TRIGGER (run_now|cron),
 * RUN_SEED_DIR (override the seed suite dir, e.g. a focused chase set),
 * RUN_MODEL_VARIANTS=true (+ ANTHROPIC_API_KEY_REDTEAM, RUN_MODEL_VARIANTS_PER_SEED)
 * to add Haiku-variant + Sonnet-strategy generation.
 */
import pg from 'pg'
import Anthropic from '@anthropic-ai/sdk'


import {
  Allowlist,
  CopilotClient,
  HttpTransport,
  TargetAdapter,
  type PatientBundle,
} from '../target/index.js'
import { AnthropicJudgeModel } from '../judge/index.js'
import { loadEvalSuite, type EvalCase } from '../evals/index.js'
import { createTracer, redactForTrace } from '../observability/index.js'
import type { DetectorContext } from '../detectors/index.js'
import type { AttackTranscript } from '@agentforge/contracts'
import {
  DEFAULT_WEIGHTS,
  PgOrchestratorRepository,
  buildNightlyPlan,
  runPlan,
} from '../orchestrator/index.js'
import type { CampaignSeed } from '../redteam/index.js'
import { modelVariantDeps } from './liveDeps.js'
import { loadAgentforgeEnv } from './loadEnv.js'
import { seedDir } from './paths.js'
import { writeRunArtifact } from './artifact.js'

const ROLE_USER_IDS: Readonly<Record<string, number>> = { clinician: 1, nurse: 2 }
const COST_PER_ATTEMPT_ESTIMATE = 0.05

function syntheticBundle(pid: number): PatientBundle {
  return {
    pid,
    correlation_id: `runnow-${Date.now()}`,
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

function toCampaignSeed(c: EvalCase): CampaignSeed {
  return {
    id: c.id,
    category: c.category,
    subcategory: c.subcategory,
    session_role: c.session_role in ROLE_USER_IDS ? c.session_role : 'clinician',
    turns: c.turns.map((t) => t.message),
    technique_tags: c.technique_tags,
    owasp_llm_ids: c.owasp_llm_ids,
    owasp_ids: c.owasp_ids,
    severity: c.severity,
  }
}

async function main(): Promise<void> {
  const envFile = loadAgentforgeEnv()
  console.log(envFile === null ? 'No AgentForge env file found.' : `Loaded env from ${envFile}`)

  const spendCapUsd = Number(process.env.RUN_SPEND_CAP_USD ?? '')
  if (!Number.isFinite(spendCapUsd) || spendCapUsd <= 0) {
    throw new Error('RUN_SPEND_CAP_USD must be set to a positive number (the hard spend cap).')
  }
  const databaseUrl = (process.env.DATABASE_URL ?? '').trim()
  if (databaseUrl === '') {
    throw new Error('DATABASE_URL is not set (the deployed Railway Postgres).')
  }
  const copilotBase = process.env.COPILOT_BASE_URL ?? 'https://copilot-evidence-production.up.railway.app/'
  const tokenSecret = (process.env.COPILOT_TOKEN_SECRET ?? '').trim()
  const judgeKey = (process.env.ANTHROPIC_API_KEY_JUDGE ?? process.env.ANTHROPIC_API_KEY ?? '').trim()
  if (tokenSecret === '') throw new Error('COPILOT_TOKEN_SECRET is not set in the env file')
  if (judgeKey === '') throw new Error('ANTHROPIC_API_KEY_JUDGE is not set in the env file')

  const categories = (process.env.RUN_CATEGORIES ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  const perFamily = Number(process.env.RUN_PER_FAMILY ?? '1')
  const maxAttempts = Number(process.env.RUN_MAX_ATTEMPTS ?? '4')
  const topK = Number(process.env.RUN_TOP_K ?? '3')
  const trigger = process.env.RUN_TRIGGER === 'cron' ? 'cron' : 'run_now'

  const clock = { now: () => Date.now(), randomUUID: () => crypto.randomUUID() }
  const transport = new HttpTransport(
    new Allowlist([copilotBase]),
    (url, init) => fetch(url, init),
    { now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)), random: () => Math.random() },
    { rpm: 20, concurrency: 1, maxRetries: 5, backoffBaseMs: 500, backoffMaxMs: 30_000 },
  )
  const copilot = new CopilotClient(transport, { baseUrl: copilotBase, tokenSecret, roleUserIds: ROLE_USER_IDS, tokenTtlSeconds: 900 }, clock)
  const realAdapter = new TargetAdapter({ copilot, clock, defaultTokenCeiling: 100_000 })

  const version = await realAdapter.getVersion()
  const buildCommit = version.includes('@') ? version.split('@')[1]! : version
  console.log(`Target version: ${version}`)

  // Model-backed Red Team variants (Haiku variants + Sonnet strategy), on only
  // with RUN_MODEL_VARIANTS=true; its key is redacted from transcripts and traces.
  const variants = modelVariantDeps(process.env)

  const sessionTokens: string[] = []
  // A redacting adapter: transcripts are stored unredacted of evidence, but any
  // minted token / API key substring is scrubbed before persistence (reuse of
  // the eval:live redaction). The Co-Pilot response body carries no token, so
  // this is defence in depth.
  const adapter = {
    getVersion: () => realAdapter.getVersion(),
    async runAttempt(params: Parameters<TargetAdapter['runAttempt']>[0]): Promise<AttackTranscript> {
      const transcript = await realAdapter.runAttempt(params)
      return redactForTrace(transcript, [...sessionTokens, tokenSecret, judgeKey, ...(variants ? [variants.secret] : [])]) as AttackTranscript
    },
  }

  const judgeModel = new AnthropicJudgeModel({ client: new Anthropic({ apiKey: judgeKey }) })
  const tracer = createTracer(process.env, { secrets: [tokenSecret, judgeKey, ...(variants ? [variants.secret] : [])] })

  const pool = new pg.Pool({ connectionString: databaseUrl, max: 4 })
  const repo = new PgOrchestratorRepository(pool)

  try {
    const targetVersionId = await repo.ensureTargetVersion(copilotBase, version)

    // Seeds, filtered to the requested scope.
    const suite = loadEvalSuite(seedDir()).filter((c) => categories.length === 0 || categories.includes(c.category))
    const seedsById = new Map<string, CampaignSeed>(suite.map((c) => [c.id, toCampaignSeed(c)]))
    const seedsByCell: Record<string, string[]> = {}
    suite.forEach((c) => {
      const key = `${c.category}/${c.subcategory}`
      ;(seedsByCell[key] ??= []).push(c.id)
    })

    // Plan inputs: drained queue + coverage cells (scoped to requested categories).
    const runDate = new Date().toISOString().slice(0, 10)
    const queue = (await repo.drainOperatorRequests(runDate)).filter((r) => categories.length === 0 || !r.category || categories.includes(r.category))
    const allCells = await repo.getCoverageCells(targetVersionId, COST_PER_ATTEMPT_ESTIMATE * maxAttempts)
    const coverageCells = allCells.filter((c) => categories.length === 0 || categories.includes(c.category))

    const plan = buildNightlyPlan({
      trigger,
      targetVersion: version,
      budgetUsd: spendCapUsd,
      weights: DEFAULT_WEIGHTS,
      operatorRequests: queue,
      coverageCells,
      seedsByCell,
      costPerAttemptUsd: COST_PER_ATTEMPT_ESTIMATE,
      maxAttemptsPerCampaign: maxAttempts,
      topK,
      traceId: `runnow-${runDate}-${Date.now()}`,
      now: new Date(),
    })
    console.log(`Plan: ${plan.run_count} run / ${plan.cut_count} cut; est $${plan.estimated_cost_usd.toFixed(3)} (cap $${spendCapUsd}).`)

    const detectorContextFor = (): DetectorContext => ({
      unauthorizedCanaries: [],
      contextPatientId: 1,
      foreignIdentifiers: [],
      allowedTools: ['intake-extractor', 'evidence-retriever'],
      maxToolCalls: 3,
    })

    const result = await runPlan({
      plan,
      adapter,
      judgeModel,
      repo,
      tracer,
      seedsById,
      detectorContextFor,
      newSession: (seed) => copilot.newSession(seed.session_role, syntheticBundle(1)),
      clock,
      spendCapUsd,
      targetBaseUrl: copilotBase,
      buildCommit,
      perFamily,
      ...(variants ? { variantGenerator: variants.variantGenerator, modelVariantsPerSeed: variants.modelVariantsPerSeed } : {}),
    })
    if (variants) console.log(`Model variants ON (${variants.modelVariantsPerSeed}/seed).`)

    // A minted-token collector is not populated because sessions are opened lazily
    // inside the adapter; the token secret itself is redacted, which covers any
    // token derived from it.
    console.log('\n=== Run now report ===')
    console.log(`nightly_run_id: ${result.nightlyRunId}  status: ${result.status}`)
    console.log(`attempts: ${result.attempts}`)
    console.log(`verdicts: ${result.verdictSplit.success}S / ${result.verdictSplit.partial}P / ${result.verdictSplit.fail}F  needs_review ${result.verdictSplit.needs_review}`)
    console.log(`confirmed exploits: ${result.newExploits.length ? result.newExploits.join(', ') : 'none'}`)
    console.log(`refusal rate: ${(result.refusalRate * 100).toFixed(1)}%`)
    console.log(`spend: $${result.spendUsd.toFixed(3)} (cap $${spendCapUsd})`)
    console.log(`trace: ${result.traceUrl ?? '(tracing disabled)'}`)
    console.log(`headline: ${result.summary.headline}`)

    const artifactPath = writeRunArtifact(result.artifact)
    console.log(`importable artifact: ${artifactPath} (import into the deployed DB with 'npm run db:import-run -- <file>')`)
  } finally {
    await tracer.flush().catch(() => {})
    await tracer.shutdown().catch(() => {})
    await pool.end()
  }
}

main().catch((error: unknown) => {
  console.error('run-now failed:', error instanceof Error ? error.message : error)
  process.exitCode = 1
})
