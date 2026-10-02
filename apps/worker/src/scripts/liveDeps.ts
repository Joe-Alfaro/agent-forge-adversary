/**
 * The live wiring the nightly entrypoints share: the Target Adapter against the
 * DEPLOYED Co-Pilot (allowlisted, rate-limited, token-redacting), the Judge, the
 * PlatformTracer, and the seed suite. Secrets come only from the operator env
 * file and are never logged.
 */
import Anthropic from '@anthropic-ai/sdk'

import type { AttackTranscript } from '@agentforge/contracts'

import type { DetectorContext } from '../detectors/index.js'
import { loadEvalSuite, type EvalCase } from '../evals/index.js'
import { AnthropicJudgeModel } from '../judge/index.js'
import { AnthropicProvider, ModelRouter } from '../models/index.js'
import { createTracer, redactForTrace } from '../observability/index.js'
import { ModelVariantGenerator, type CampaignSeed } from '../redteam/index.js'
import { Allowlist, CopilotClient, HttpTransport, TargetAdapter, type PatientBundle } from '../target/index.js'
import { seedDir } from './paths.js'

const ROLE_USER_IDS: Readonly<Record<string, number>> = { clinician: 1, nurse: 2 }
/** Red Team tiers (ARCHITECTURE 4.2): Haiku for variants, Sonnet for per-campaign strategy. */
const VARIANT_MODEL = 'claude-haiku-4-5-20251001'
const STRATEGY_MODEL = 'claude-sonnet-5-5'

/**
 * Model-backed Red Team variants, on only with RUN_MODEL_VARIANTS=true (they
 * spend). Uses its own key, ANTHROPIC_API_KEY_REDTEAM, separate from the Judge.
 */
export function modelVariantDeps(env: NodeJS.ProcessEnv): { variantGenerator: ModelVariantGenerator; modelVariantsPerSeed: number; secret: string } | null {
  if (env.RUN_MODEL_VARIANTS !== 'true') return null
  const key = (env.ANTHROPIC_API_KEY_REDTEAM ?? '').trim()
  if (key === '') throw new Error('RUN_MODEL_VARIANTS=true needs ANTHROPIC_API_KEY_REDTEAM in the env file')
  const client = new Anthropic({ apiKey: key })
  const messages = { create: (body: Parameters<typeof client.messages.create>[0]) => client.messages.create({ ...body, stream: false }) }
  const router = new ModelRouter({
    anthropicVariant: new AnthropicProvider({ client: { messages }, model: VARIANT_MODEL }),
    anthropicStrategy: new AnthropicProvider({ client: { messages }, model: STRATEGY_MODEL }),
    config: { openrouterEnabled: false, highRefusalCategories: new Set() },
  })
  const perSeed = Number(env.RUN_MODEL_VARIANTS_PER_SEED ?? '3')
  if (!Number.isInteger(perSeed) || perSeed < 1) throw new Error('RUN_MODEL_VARIANTS_PER_SEED must be a positive integer')
  return { variantGenerator: new ModelVariantGenerator({ router }), modelVariantsPerSeed: perSeed, secret: key }
}

function syntheticBundle(pid: number): PatientBundle {
  return {
    pid,
    correlation_id: `nightly-${Date.now()}`,
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

/** Reads a required positive dollar amount (a hard spend cap). */
export function requirePositiveUsd(env: NodeJS.ProcessEnv, name: string): number {
  const value = Number(env[name] ?? '')
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be set to a positive number (the hard spend cap).`)
  }
  return value
}

export function liveDeps(env: NodeJS.ProcessEnv = process.env) {
  const copilotBase = env.COPILOT_BASE_URL ?? 'https://copilot-evidence-production.up.railway.app/'
  const tokenSecret = (env.COPILOT_TOKEN_SECRET ?? '').trim()
  const judgeKey = (env.ANTHROPIC_API_KEY_JUDGE ?? env.ANTHROPIC_API_KEY ?? '').trim()
  if (tokenSecret === '') throw new Error('COPILOT_TOKEN_SECRET is not set in the env file')
  if (judgeKey === '') throw new Error('ANTHROPIC_API_KEY_JUDGE is not set in the env file')

  const variants = modelVariantDeps(env)
  const secrets = [tokenSecret, judgeKey, ...(variants ? [variants.secret] : [])]
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
      return redactForTrace(t, secrets) as AttackTranscript
    },
  }

  const suite = loadEvalSuite(seedDir())
  const detectorContextFor = (): DetectorContext => ({
    unauthorizedCanaries: [],
    contextPatientId: 1,
    foreignIdentifiers: [],
    allowedTools: ['intake-extractor', 'evidence-retriever'],
    maxToolCalls: 3,
  })

  return {
    copilotBase,
    clock,
    adapter,
    suite,
    seedsById: new Map<string, CampaignSeed>(suite.map((c) => [c.id, toCampaignSeed(c)])),
    judgeModel: new AnthropicJudgeModel({ client: new Anthropic({ apiKey: judgeKey }) }),
    tracer: createTracer(env, { secrets }),
    detectorContextFor,
    newSession: (seed: CampaignSeed) => copilot.newSession(seed.session_role, syntheticBundle(1)),
    perFamily: Number(env.RUN_PER_FAMILY ?? '1'),
    ...(variants ? { variantGenerator: variants.variantGenerator, modelVariantsPerSeed: variants.modelVariantsPerSeed } : {}),
  }
}

export type LiveDeps = ReturnType<typeof liveDeps>
