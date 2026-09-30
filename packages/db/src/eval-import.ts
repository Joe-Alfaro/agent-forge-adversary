import type { NightlyRunSummary } from '@agentforge/contracts'

import type { ImportPlan, PlannedAttempt, PlannedEvent } from './import-writer.js'

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

function plural(count: number, singular: string, pluralForm: string) {
  return `${count} ${count === 1 ? singular : pluralForm}`
}

export function planEvalImport(results: EvalResultsFile, seeds: SeedCase[], source: string): ImportPlan {
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
      parentAttemptId: null,
      fingerprint: `seed:${result.id}`,
      category: result.category,
      subcategory: result.subcategory,
      owaspIds: [...seed.owasp_llm_ids, ...seed.owasp_ids],
      techniqueTags: seed.technique_tags ?? [],
      transcript: result.transcript,
      tokens: (totals?.input_tokens ?? 0) + (totals?.output_tokens ?? 0),
      costUsd: 0,
      createdAt: result.transcript.produced_at,
      verdicts: [
        {
          outcome: result.outcome,
          confidence: result.confidence,
          stage: result.stage,
          rubricVersion: result.rubric_version,
          judgeModel: result.judge_model ?? null,
          evidence: result.detectors,
          needsReview: result.needs_review,
          createdAt: result.transcript.produced_at,
        },
      ],
    }
  })

  const events = results.cases.map(
    (result): PlannedEvent => ({
      traceId: result.transcript.trace_id,
      agent: 'judge',
      eventType: 'verdict',
      payload: { attempt_id: result.transcript.attempt_id, outcome: result.outcome },
      source: 'eval_import',
      costUsd: judgeCostUsd,
      createdAt: result.transcript.produced_at,
    }),
  )

  const confirmed = results.cases.filter((result) => result.outcome === 'success').length
  const categories = new Set(results.cases.map((result) => result.category)).size
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
    kind: 'live_eval',
    target: results.target,
    run: {
      startedAt,
      finishedAt: results.generated_at,
      trigger: 'run_now',
      status: 'completed',
      spendUsd: results.spend_estimate_usd.total,
      summary,
    },
    campaigns: attempts.map((attempt) => ({
      id: attempt.campaignId,
      plan: { seed_case_ids: [attempt.fingerprint.slice('seed:'.length)] },
      budgetUsd: 0,
      spendUsd: judgeCostUsd,
      status: 'completed',
      startedAt: attempt.createdAt,
    })),
    attempts,
    exploits: [],
    events,
    coverage: null,
    requestIds: [],
  }
}
