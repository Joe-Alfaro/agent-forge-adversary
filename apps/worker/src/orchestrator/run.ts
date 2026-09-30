import {
  isTaxonomyCell,
  validateNightlyRunSummary,
  type NightlyPlan,
  type NightlyPlanItem,
  type NightlyRunSummary,
} from '@agentforge/contracts'

import { runDetectors, type DetectorContext, type RunDetectorsClock } from '../detectors/index.js'
import { judgeAttempt, type JudgeModel } from '../judge/index.js'
import type { PlatformTracer, TraceScope } from '../observability/index.js'
import { runCampaign, type CampaignAdapter, type CampaignSeed, type AttemptDetail } from '../redteam/index.js'
import type { CoverageSnapshotRow, OrchestratorRepository } from './repository.js'

/**
 * The Orchestrator RUN executor (ARCHITECTURE 7.0). It runs a NightlyPlan end to
 * end: for each `run` item it drives a Red Team campaign through the Target
 * Adapter, runs the deterministic detectors and the Judge on every attempt,
 * persists attempts and verdicts, dedupes confirmed exploits by fingerprint,
 * materializes coverage_snapshots (asserting each cell is in AttackTaxonomy v1),
 * and writes one nightly_runs row with a validated NightlyRunSummary and spend.
 *
 * A hard dollar spend cap is enforced: the run aborts gracefully the moment the
 * running estimate would exceed it, so a demo or live run can never overspend.
 * The whole run and each step are wrapped in the PlatformTracer, and the trace
 * URL is written into the summary.
 */

export interface CostModel {
  /** Rough per-token target rates (USD) for the estimate. */
  targetInputPerToken: number
  targetOutputPerToken: number
  /** Flat per-Judge-call estimate (USD). */
  judgePerCallUsd: number
}

export const DEFAULT_COST_MODEL: CostModel = {
  targetInputPerToken: 3 / 1_000_000,
  targetOutputPerToken: 15 / 1_000_000,
  judgePerCallUsd: 0.008,
}

export interface RunPlanParams {
  plan: NightlyPlan
  adapter: CampaignAdapter
  judgeModel: JudgeModel
  repo: OrchestratorRepository
  tracer: PlatformTracer
  /** Resolves a seed id to the campaign seed the Red Team should run. */
  seedsById: Map<string, CampaignSeed>
  /** Detector context per cell key (`category/subcategory`); a default is used otherwise. */
  detectorContextFor: (item: NightlyPlanItem) => DetectorContext
  /** Opens a target session for a seed (passed opaquely to the adapter). */
  newSession: (seed: CampaignSeed) => unknown
  clock: RunDetectorsClock
  /** Hard USD cap; the run aborts before exceeding it. */
  spendCapUsd: number
  targetBaseUrl: string
  buildCommit?: string
  costModel?: CostModel
  perFamily?: number
  scheduledFor?: string
}

export interface RunPlanResult {
  nightlyRunId: number
  status: 'completed' | 'aborted'
  attempts: number
  verdictSplit: { success: number; partial: number; fail: number; needs_review: number }
  newExploits: string[]
  refusalRate: number
  spendUsd: number
  traceUrl: string | null
  summary: NightlyRunSummary
}

const SEVERITY_BY_CATEGORY: Record<string, string> = {
  data_exfiltration: 'critical',
  prompt_injection: 'high',
  identity_role_exploitation: 'high',
  tool_misuse: 'high',
  state_corruption: 'medium',
  denial_of_service: 'medium',
  misinformation: 'medium',
}

export async function runPlan(params: RunPlanParams): Promise<RunPlanResult> {
  const cost = params.costModel ?? DEFAULT_COST_MODEL
  const trace = params.tracer.startTrace({
    name: `nightly ${params.plan.target_version}`,
    ...(params.buildCommit ? { buildCommit: params.buildCommit } : {}),
    metadata: { trigger: params.plan.trigger, budget_usd: params.plan.budget_usd },
  })

  const targetVersionId = await params.repo.ensureTargetVersion(params.targetBaseUrl, params.plan.target_version)
  const nightlyRunId = await params.repo.createNightlyRun({
    scheduledFor: params.scheduledFor ?? new Date(params.clock.now()).toISOString(),
    trigger: params.plan.trigger,
    plan: params.plan,
  })

  const verdictSplit = { success: 0, partial: 0, fail: 0, needs_review: 0 }
  const newExploits: string[] = []
  const notes: string[] = []
  const coverage = new Map<string, { attempts: number; confirmed: number; roots: Set<string>; families: Set<string>; lastRunAt: string }>()
  let spendUsd = 0
  let attempts = 0
  let refusals = 0
  let aborted = false

  const runItems = params.plan.items.filter((i) => i.decision === 'run')

  for (const item of runItems) {
    if (aborted) break
    const seeds = item.seed_case_ids.map((id) => params.seedsById.get(id)).filter((s): s is CampaignSeed => s !== undefined)
    if (seeds.length === 0) {
      notes.push(`No seeds for ${item.item_id}; skipped.`)
      continue
    }
    const campaignId = await params.repo.createCampaign({ nightlyRunId, plan: item, budgetUsd: item.estimated_cost_usd })

    const campaign = await runCampaign({
      adapter: params.adapter,
      seeds,
      newSession: params.newSession,
      clock: params.clock,
      perFamily: params.perFamily ?? 1,
      maxAttempts: item.max_attempts,
      campaignId,
    })
    refusals += campaign.refusals

    const detectorContext = params.detectorContextFor(item)
    const rootAttemptBySeed = new Map<string, string>()
    let campaignSpend = 0

    for (const detail of campaign.attemptsDetail) {
      // Hard spend cap: stop before incurring more cost.
      const attemptTargetCost =
        detail.transcript.totals.input_tokens * cost.targetInputPerToken +
        detail.transcript.totals.output_tokens * cost.targetOutputPerToken
      if (spendUsd + attemptTargetCost + cost.judgePerCallUsd > params.spendCapUsd) {
        aborted = true
        notes.push(`Spend cap $${params.spendCapUsd} reached; aborted before completing ${item.item_id}.`)
        break
      }

      const detectorResult = runDetectors(detail.transcript, detectorContext, params.clock)
      trace.span({
        name: `detectors:${detail.fingerprint.slice(0, 8)}`,
        output: { any_fired: detectorResult.any_fired, results: detectorResult.results.map((r) => ({ detector: r.detector, status: r.status })) },
      })

      const verdict = await judgeAttempt({
        transcript: detail.transcript,
        detectorResult,
        category: item.category,
        model: params.judgeModel,
        clock: params.clock,
      })
      // A detector-authoritative verdict costs no model call.
      const judgeCost = verdict.stage === 'detector' ? 0 : cost.judgePerCallUsd
      recordGeneration(trace, verdict.stage, verdict.outcome, params.judgeModel.id)

      const attemptCost = attemptTargetCost + judgeCost
      spendUsd += attemptCost
      campaignSpend += attemptCost
      attempts += 1

      const parentAttemptId = detail.isSeed ? null : rootAttemptBySeed.get(detail.seedId) ?? null
      const attemptId = await params.repo.insertAttempt({
        campaignId,
        parentAttemptId,
        fingerprint: detail.fingerprint,
        category: item.category,
        ...(item.subcategory ? { subcategory: item.subcategory } : {}),
        owaspIds: [],
        techniqueTags: [detail.family],
        transcript: detail.transcript,
        targetVersionId,
        tokens: detail.transcript.totals.input_tokens + detail.transcript.totals.output_tokens,
        costUsd: attemptCost,
      })
      if (detail.isSeed) rootAttemptBySeed.set(detail.seedId, attemptId)

      await params.repo.insertVerdict({ attemptId, verdict })
      verdictSplit[verdict.outcome] += 1
      if (verdict.needs_review) verdictSplit.needs_review += 1

      // Coverage bookkeeping for this cell.
      if (item.subcategory) {
        const key = `${item.category}/${item.subcategory}`
        const entry = coverage.get(key) ?? { attempts: 0, confirmed: 0, roots: new Set(), families: new Set(), lastRunAt: new Date(params.clock.now()).toISOString() }
        entry.attempts += 1
        entry.lastRunAt = new Date(params.clock.now()).toISOString()
        if (!detail.isSeed) entry.roots.add(detail.seedId)
        entry.families.add(detail.family)
        // A confirmed exploit: a non-needs_review success (detector-authoritative
        // or a corroborated LLM success) becomes a deduplicated exploit record.
        if (verdict.outcome === 'success' && !verdict.needs_review) {
          entry.confirmed += 1
          const upserted = await params.repo.upsertExploit({
            fingerprint: detail.fingerprint,
            severity: SEVERITY_BY_CATEGORY[item.category] ?? 'medium',
            category: item.category,
            subcategory: item.subcategory,
            owaspIds: [],
            minRepro: { turns: detail.transcript.turns.map((t) => t.attacker_message), attempt_id: attemptId },
            discoveredVersionId: targetVersionId,
            familyIds: [],
          })
          if (upserted.isNew) newExploits.push(upserted.id)
        }
        coverage.set(key, entry)
      }
    }

    await params.repo.updateCampaign(campaignId, { spendUsd: campaignSpend, status: aborted ? 'aborted' : 'completed' })
  }

  // Materialize coverage_snapshots (assert the cell before insert; ARCHITECTURE 7.5).
  for (const [key, entry] of coverage) {
    const [category, subcategory] = key.split('/') as [string, string]
    if (!isTaxonomyCell(category, subcategory)) {
      notes.push(`Refused to snapshot non-taxonomy cell ${key}.`)
      continue
    }
    const row: CoverageSnapshotRow = {
      targetVersionId,
      category,
      subcategory,
      attempts: entry.attempts,
      confirmed: entry.confirmed,
      familiesExercised: entry.roots.size,
      lastRunAt: entry.lastRunAt,
    }
    await params.repo.upsertCoverageSnapshot(row)
  }

  const totalAttempts = attempts
  const refusalRate = totalAttempts === 0 ? 0 : refusals / totalAttempts
  const status: 'completed' | 'aborted' = aborted ? 'aborted' : 'completed'
  const traceUrl = trace.url()

  const summary: NightlyRunSummary = {
    target_version: params.plan.target_version,
    headline: `${totalAttempts} attempts, ${newExploits.length} new finding(s), ${verdictSplit.success} success / ${verdictSplit.partial} partial / ${verdictSplit.fail} fail; spend $${spendUsd.toFixed(3)}${aborted ? ' (aborted at cap)' : ''}`,
    new_tickets: newExploits,
    regressions: [],
    verified_fixes: [],
    queue: { ran: params.plan.run_count, cut: params.plan.cut_count },
    notes,
    ...(traceUrl ? { trace_url: traceUrl } : {}),
    generated_at: new Date(params.clock.now()).toISOString(),
  }
  const check = validateNightlyRunSummary(summary)
  if (!check.valid) {
    throw new Error(`Executor produced an invalid NightlyRunSummary: ${check.errors.join('; ')}`)
  }

  trace.update({ attempts: totalAttempts, spend_usd: spendUsd, status })
  await params.repo.finishNightlyRun(nightlyRunId, { summary, spendUsd, status })

  // Resolve operator requests: reruns that ran -> ran, cut items -> cut.
  for (const item of params.plan.items) {
    if (item.kind === 'operator_request' && item.request_id) {
      await params.repo.setRequestStatus(item.request_id, item.decision === 'run' && !aborted ? 'ran' : 'cut', nightlyRunId)
    }
  }

  await params.tracer.flush()
  await params.tracer.shutdown()

  return {
    nightlyRunId,
    status,
    attempts: totalAttempts,
    verdictSplit,
    newExploits,
    refusalRate,
    spendUsd,
    traceUrl,
    summary,
  }
}

function recordGeneration(trace: TraceScope, stage: string, outcome: string, modelId: string): void {
  trace.generation({
    name: `judge:${stage}`,
    model: stage === 'detector' ? 'detectors' : modelId,
    output: { outcome, stage },
  })
}
