/**
 * Consumes scheduled `run_now` rows the dashboard "Run now" button inserts into
 * nightly_runs (agentforge-8 seam), executing each against the deployed Co-Pilot
 * and writing to the Postgres in DATABASE_URL. For the interactive demo this
 * points at a LOCAL Postgres (the Railway DB is private-network only); each run
 * also emits an importable artifact so the deployed dashboard can be refreshed.
 *
 * Drains every currently-scheduled row (one campaign each) and stops. Same hard
 * spend cap and secret handling as run:now.
 *
 * Usage (after `npm run build`):
 *   RUN_SPEND_CAP_USD=3 DATABASE_URL=postgres://localhost/agentforge \
 *   npm run run:consume -w apps/worker
 */
import pg from 'pg'
import Anthropic from '@anthropic-ai/sdk'

import {
  Allowlist,
  CopilotClient,
  HttpTransport,
  TargetAdapter,
  armedDataExfilContext,
  canaryBundle,
  dataExfilArmed,
  unarmedDetectorContext,
  type PatientBundle,
} from '../target/index.js'
import { AnthropicJudgeModel } from '../judge/index.js'
import { loadEvalSuite, type EvalCase } from '../evals/index.js'
import { createTracer, redactForTrace } from '../observability/index.js'
import type { DetectorContext } from '../detectors/index.js'
import type { AttackTranscript } from '@agentforge/contracts'
import { DEFAULT_WEIGHTS, PgOrchestratorRepository, runScheduledRunNow } from '../orchestrator/index.js'
import type { CampaignSeed } from '../redteam/index.js'
import { loadAgentforgeEnv } from './loadEnv.js'
import { seedDir } from './paths.js'
import { writeRunArtifact } from './artifact.js'

const ROLE_USER_IDS: Readonly<Record<string, number>> = { clinician: 1, nurse: 2 }
const COST_PER_ATTEMPT_ESTIMATE = 0.05

function syntheticBundle(pid: number): PatientBundle {
  return {
    pid,
    correlation_id: `consume-${Date.now()}`,
    retrieved_at: new Date().toISOString(),
    sections: {
      demographics: { status: 'ok', count: 1, records: [{ _source: { table: 'patient_data', row_id: pid }, fname: 'Test', lname: 'Patient', DOB: '1970-01-01' }] },
      medications: { status: 'ok', count: 1, records: [{ _source: { table: 'lists', row_id: 1 }, title: 'lisinopril 10mg', comments: 'daily' }] },
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
  if (!Number.isFinite(spendCapUsd) || spendCapUsd <= 0) throw new Error('RUN_SPEND_CAP_USD must be a positive number (hard cap).')
  const databaseUrl = (process.env.DATABASE_URL ?? '').trim()
  if (databaseUrl === '') throw new Error('DATABASE_URL is not set (use a reachable — local — Postgres).')
  const copilotBase = process.env.COPILOT_BASE_URL ?? 'https://copilot-evidence-production.up.railway.app/'
  const tokenSecret = (process.env.COPILOT_TOKEN_SECRET ?? '').trim()
  const judgeKey = (process.env.ANTHROPIC_API_KEY_JUDGE ?? process.env.ANTHROPIC_API_KEY ?? '').trim()
  if (tokenSecret === '') throw new Error('COPILOT_TOKEN_SECRET is not set in the env file')
  if (judgeKey === '') throw new Error('ANTHROPIC_API_KEY_JUDGE is not set in the env file')
  const maxAttempts = Number(process.env.RUN_MAX_ATTEMPTS ?? '4')
  const perFamily = Number(process.env.RUN_PER_FAMILY ?? '1')

  const clock = { now: () => Date.now(), randomUUID: () => crypto.randomUUID() }
  const transport = new HttpTransport(
    new Allowlist([copilotBase]),
    (url, init) => fetch(url, init),
    { now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)), random: () => Math.random() },
    { rpm: 20, concurrency: 1, maxRetries: 5, backoffBaseMs: 500, backoffMaxMs: 30_000 },
  )
  const copilot = new CopilotClient(transport, { baseUrl: copilotBase, tokenSecret, roleUserIds: ROLE_USER_IDS, tokenTtlSeconds: 900 }, clock)
  const realAdapter = new TargetAdapter({ copilot, clock, defaultTokenCeiling: 100_000 })
  const adapter = {
    getVersion: () => realAdapter.getVersion(),
    async runAttempt(params: Parameters<TargetAdapter['runAttempt']>[0]): Promise<AttackTranscript> {
      const t = await realAdapter.runAttempt(params)
      return redactForTrace(t, [tokenSecret, judgeKey]) as AttackTranscript
    },
  }
  const judgeModel = new AnthropicJudgeModel({ client: new Anthropic({ apiKey: judgeKey }) })
  const tracer = createTracer(process.env, { secrets: [tokenSecret, judgeKey] })
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 4 })
  const repo = new PgOrchestratorRepository(pool)

  const version = await realAdapter.getVersion()
  const buildCommit = version.includes('@') ? version.split('@')[1]! : version
  console.log(`Target version: ${version}`)

  const suite = loadEvalSuite(seedDir())
  const seedsById = new Map<string, CampaignSeed>(suite.map((c) => [c.id, toCampaignSeed(c)]))
  const seedsByCell: Record<string, string[]> = {}
  suite.forEach((c) => {
    const key = `${c.category}/${c.subcategory}`
    ;(seedsByCell[key] ??= []).push(c.id)
  })

  const armed = dataExfilArmed(process.env)
  const detectorContextFor = (): DetectorContext => (armed ? armedDataExfilContext() : unarmedDetectorContext())
  if (armed) console.log('Data-exfil canary ARMED (phi_canary + cross_patient).')

  try {
    let drained = 0
    // Claim and run every scheduled row currently in the queue.
    for (;;) {
      const result = await runScheduledRunNow({
        adapter,
        judgeModel,
        repo,
        tracer,
        seedsById,
        seedsByCell,
        coverageCells: [],
        weights: DEFAULT_WEIGHTS,
        costPerAttemptUsd: COST_PER_ATTEMPT_ESTIMATE,
        maxAttemptsPerCampaign: maxAttempts,
        topK: 3,
        runDate: new Date().toISOString().slice(0, 10),
        targetVersion: version,
        detectorContextFor,
        newSession: (seed) => copilot.newSession(seed.session_role, armed ? canaryBundle() : syntheticBundle(1)),
        clock,
        spendCapUsd,
        targetBaseUrl: copilotBase,
        buildCommit,
        perFamily,
      })
      if (result === null) break
      drained += 1
      const artifactPath = writeRunArtifact(result.artifact)
      console.log(`\n=== Run now (row ${result.nightlyRunId}) ===`)
      console.log(`status ${result.status}; attempts ${result.attempts}; ${result.verdictSplit.success}S/${result.verdictSplit.partial}P/${result.verdictSplit.fail}F needs_review ${result.verdictSplit.needs_review}`)
      console.log(`confirmed: ${result.newExploits.length ? result.newExploits.join(', ') : 'none'}; refusal ${(result.refusalRate * 100).toFixed(1)}%; spend $${result.spendUsd.toFixed(3)} (cap $${spendCapUsd})`)
      console.log(`trace: ${result.traceUrl ?? '(tracing disabled)'}`)
      console.log(`artifact: ${artifactPath}`)
    }
    console.log(drained === 0 ? 'No scheduled run_now rows to consume.' : `\nConsumed ${drained} scheduled run(s).`)
  } finally {
    await tracer.flush().catch(() => {})
    await tracer.shutdown().catch(() => {})
    await pool.end()
  }
}

main().catch((error: unknown) => {
  console.error('consume-run-now failed:', error instanceof Error ? error.message : error)
  process.exitCode = 1
})
