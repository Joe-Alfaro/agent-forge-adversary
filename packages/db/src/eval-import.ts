import type { NightlyRunSummary } from '@agentforge/contracts'
import type pg from 'pg'

/**
 * Loads a live eval results file (`evals/results/*.json`, written by the
 * worker's `eval:live`) into the platform tables, so the dashboard shows real
 * Judge verdicts before the nightly Orchestrator writes runs itself. The file
 * becomes one completed `run_now` run: one campaign, attempt, and verdict per
 * case, plus a Judge cost event. Nothing is invented. A case that did not
 * succeed does not become a ticket.
 */

export interface EvalCaseResult {
  id: string
  category: string
  subcategory: string
  outcome: 'success' | 'partial' | 'fail'
  confidence: number
  stage: string
  needs_review: boolean
  rubric_version: string
  judge_model?: string
  detectors: unknown[]
  transcript: {
    campaign_id: string
    attempt_id: string
    trace_id: string
    produced_at: string
    totals?: { input_tokens?: number; output_tokens?: number }
  }
}

export interface EvalResultsFile {
  generated_at: string
  target: { name: string; base_url: string; version: string }
  trace_url?: string
  spend_estimate_usd: { judge: number; total: number; cap?: number }
  cases: EvalCaseResult[]
}

/** The fields of an `evals/seeds` case the import needs for the OWASP mapping. */
export interface SeedCase {
  id: string
  owasp_llm_ids: string[]
  owasp_ids: string[]
  technique_tags?: string[]
}

export interface PlannedAttempt {
  id: string
  campaignId: string
  fingerprint: string
  category: string
  subcategory: string
  owaspIds: string[]
  techniqueTags: string[]
  transcript: EvalCaseResult['transcript']
  tokens: number
  createdAt: string
  traceId: string
  judgeCostUsd: number
  verdict: {
    outcome: EvalCaseResult['outcome']
    confidence: number
    stage: string
    rubricVersion: string
    judgeModel: string | null
    evidence: unknown[]
    needsReview: boolean
  }
}

export interface EvalImportPlan {
  importKey: string
  target: EvalResultsFile['target']
  run: {
    startedAt: string
    finishedAt: string
    trigger: 'run_now'
    status: 'completed'
    spendUsd: number
    summary: NightlyRunSummary
  }
  attempts: PlannedAttempt[]
}

export type EvalImportResult = { status: 'imported' | 'already_imported'; runId: number }

function plural(count: number, singular: string, pluralForm: string) {
  return `${count} ${count === 1 ? singular : pluralForm}`
}

export function planEvalImport(results: EvalResultsFile, seeds: SeedCase[], source: string): EvalImportPlan {
  const seedsById = new Map(seeds.map((seed) => [seed.id, seed]))
  const judgeCostUsd = results.cases.length > 0 ? results.spend_estimate_usd.judge / results.cases.length : 0

  const attempts = results.cases.map((result): PlannedAttempt => {
    const seed = seedsById.get(result.id)
    if (!seed) {
      throw new Error(`No seed case "${result.id}" in evals/seeds; refusing to import it without its OWASP mapping`)
    }
    const totals = result.transcript.totals
    return {
      id: result.transcript.attempt_id,
      campaignId: result.transcript.campaign_id,
      fingerprint: `seed:${result.id}`,
      category: result.category,
      subcategory: result.subcategory,
      owaspIds: [...seed.owasp_llm_ids, ...seed.owasp_ids],
      techniqueTags: seed.technique_tags ?? [],
      transcript: result.transcript,
      tokens: (totals?.input_tokens ?? 0) + (totals?.output_tokens ?? 0),
      createdAt: result.transcript.produced_at,
      traceId: result.transcript.trace_id,
      judgeCostUsd,
      verdict: {
        outcome: result.outcome,
        confidence: result.confidence,
        stage: result.stage,
        rubricVersion: result.rubric_version,
        judgeModel: result.judge_model ?? null,
        evidence: result.detectors,
        needsReview: result.needs_review,
      },
    }
  })

  const confirmed = attempts.filter((attempt) => attempt.verdict.outcome === 'success').length
  const categories = new Set(attempts.map((attempt) => attempt.category)).size
  const startedAt = attempts.map((attempt) => attempt.createdAt).sort()[0] ?? results.generated_at
  const summary: NightlyRunSummary = {
    target_version: results.target.version,
    headline: `Live eval against ${results.target.version}: ${plural(attempts.length, 'attempt', 'attempts')} across ${plural(categories, 'category', 'categories')}, ${confirmed} confirmed.`,
    new_tickets: [],
    regressions: [],
    verified_fixes: [],
    queue: { ran: 0, cut: 0 },
    notes: [
      `Imported from ${source}: seed cases run once through the live Judge, not a scheduled Orchestrator run.`,
      `Spend is the eval's own estimate ($${results.spend_estimate_usd.total.toFixed(3)}); the target's model cost was not reported.`,
    ],
    ...(results.trace_url ? { trace_url: results.trace_url } : {}),
    generated_at: results.generated_at,
  }

  return {
    importKey: `eval-import:${source}`,
    target: results.target,
    run: {
      startedAt,
      finishedAt: results.generated_at,
      trigger: 'run_now',
      status: 'completed',
      spendUsd: results.spend_estimate_usd.total,
      summary,
    },
    attempts,
  }
}

/** Writes the plan in one transaction; a second import of the same file does nothing. */
export async function importEvalResults(pool: pg.Pool, plan: EvalImportPlan): Promise<EvalImportResult> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    // Serialize concurrent imports of the same file.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [plan.importKey])
    const existing = await client.query<{ id: number }>(
      `SELECT id FROM nightly_runs WHERE plan->>'import_key' = $1`,
      [plan.importKey],
    )
    if (existing.rows[0]) {
      await client.query('ROLLBACK')
      return { status: 'already_imported', runId: existing.rows[0].id }
    }

    const target = await client.query<{ id: number }>(
      `INSERT INTO targets (base_url, kind, allowlisted_by) VALUES ($1, $2, 'eval-import')
       ON CONFLICT (base_url) DO UPDATE SET base_url = EXCLUDED.base_url RETURNING id`,
      [plan.target.base_url, plan.target.name],
    )
    const targetId = target.rows[0]!.id
    const version = await client.query<{ id: number }>(
      `INSERT INTO target_versions (target_id, version, first_seen) VALUES ($1, $2, $3)
       ON CONFLICT (target_id, version) DO UPDATE SET version = EXCLUDED.version RETURNING id`,
      [targetId, plan.target.version, plan.run.startedAt],
    )
    const versionId = version.rows[0]!.id

    const run = await client.query<{ id: number }>(
      `INSERT INTO nightly_runs (scheduled_for, started_at, finished_at, trigger, plan, summary, spend_usd, status)
       VALUES ($1, $1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [
        plan.run.startedAt,
        plan.run.finishedAt,
        plan.run.trigger,
        { import_key: plan.importKey, kind: 'live_eval' },
        plan.run.summary,
        plan.run.spendUsd,
        plan.run.status,
      ],
    )
    const runId = run.rows[0]!.id

    // Sequential on purpose: one client cannot run queries concurrently.
    await plan.attempts.reduce(async (previous, attempt) => {
      await previous
      await client.query(
        `INSERT INTO campaigns (id, nightly_run_id, plan, budget_usd, spend_usd, status, started_at)
         VALUES ($1, $2, $3, 0, $4, 'completed', $5)`,
        [attempt.campaignId, runId, { seed_case_ids: [attempt.fingerprint.slice('seed:'.length)] }, attempt.judgeCostUsd, attempt.createdAt],
      )
      await client.query(
        `INSERT INTO attempts (id, campaign_id, fingerprint, category, subcategory, owasp_ids, technique_tags,
                               transcript, target_version_id, tokens, cost_usd, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 0, $11)`,
        [
          attempt.id, attempt.campaignId, attempt.fingerprint, attempt.category, attempt.subcategory,
          attempt.owaspIds, attempt.techniqueTags, attempt.transcript, versionId, attempt.tokens, attempt.createdAt,
        ],
      )
      await client.query(
        `INSERT INTO verdicts (attempt_id, outcome, confidence, stage, rubric_version, judge_model, evidence, needs_review, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          attempt.id, attempt.verdict.outcome, attempt.verdict.confidence, attempt.verdict.stage,
          attempt.verdict.rubricVersion, attempt.verdict.judgeModel, JSON.stringify(attempt.verdict.evidence),
          attempt.verdict.needsReview, attempt.createdAt,
        ],
      )
      await client.query(
        `INSERT INTO agent_events (trace_id, agent, event_type, payload, source, cost_usd, created_at)
         VALUES ($1, 'judge', 'verdict', $2, 'eval_import', $3, $4)`,
        [attempt.traceId, { attempt_id: attempt.id, outcome: attempt.verdict.outcome }, attempt.judgeCostUsd, attempt.createdAt],
      )
    }, Promise.resolve())

    await client.query('COMMIT')
    return { status: 'imported', runId }
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}
