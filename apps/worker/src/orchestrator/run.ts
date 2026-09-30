import {
  isTaxonomyCell,
  validateNightlyRunSummary,
  type CampaignPlan,
  type NightlyPlan,
  type NightlyPlanItem,
  type NightlyRunSummary,
} from '@agentforge/contracts'
import type {
  RunArtifact,
  RunArtifactAttempt,
  RunArtifactCampaign,
  RunArtifactCoverage,
  RunArtifactEvent,
  RunArtifactExploit,
} from '@agentforge/db'

import { runDetectors, type DetectorContext, type RunDetectorsClock } from '../detectors/index.js'
import { judgeAttempt, type JudgeModel } from '../judge/index.js'
import type { PlatformTracer, TraceScope } from '../observability/index.js'
import { runCampaign, type CampaignAdapter, type CampaignSeed, type AttemptDetail } from '../redteam/index.js'
import { buildNightlyPlan, type QueuedRequest } from './planner.js'
import type { AgentEventRow, CoverageSnapshotRow, OrchestratorRepository } from './repository.js'

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
  /**
   * The importable RunArtifact v1 (packages/db run-import.ts) for this run. It
   * lets a run against a reachable (local) Postgres also refresh a deployed
   * database it cannot reach directly: `agentforge-6` imports this JSON via
   * `db:import-run`.
   */
  artifact: RunArtifact
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

/**
 * Runs a plan by first creating its own `nightly_runs` row (the CLI Run-now and
 * cron path). The dashboard-button path uses {@link runScheduledRunNow}, which
 * claims a pre-inserted row instead; both share the {@link executePlan} core.
 */
export async function runPlan(params: RunPlanParams): Promise<RunPlanResult> {
  const targetVersionId = await params.repo.ensureTargetVersion(params.targetBaseUrl, params.plan.target_version)
  const nightlyRunId = await params.repo.createNightlyRun({
    scheduledFor: params.scheduledFor ?? new Date(params.clock.now()).toISOString(),
    trigger: params.plan.trigger,
    plan: params.plan,
  })
  return executePlan(params, nightlyRunId, targetVersionId)
}

async function executePlan(
  params: RunPlanParams,
  nightlyRunId: number,
  targetVersionId: number,
): Promise<RunPlanResult> {
  const cost = params.costModel ?? DEFAULT_COST_MODEL
  const trace = params.tracer.startTrace({
    name: `nightly ${params.plan.target_version}`,
    ...(params.buildCommit ? { buildCommit: params.buildCommit } : {}),
    metadata: { trigger: params.plan.trigger, budget_usd: params.plan.budget_usd },
  })

  const verdictSplit = { success: 0, partial: 0, fail: 0, needs_review: 0 }
  const newExploits: string[] = []
  const notes: string[] = []
  const coverage = new Map<string, { attempts: number; confirmed: number; roots: Set<string>; families: Set<string>; lastRunAt: string }>()
  let spendUsd = 0
  let attempts = 0
  let refusals = 0
  let aborted = false

  const startedAtIso = new Date(params.clock.now()).toISOString()
  const artifactCampaigns: RunArtifactCampaign[] = []
  const artifactExploits = new Map<string, RunArtifactExploit>()
  const artifactEvents: RunArtifactEvent[] = []
  const seedOwaspFor = (seedId: string) => params.seedsById.get(seedId)?.owasp_ids ?? []

  // Per-role spend/audit rows: written to the local DB and mirrored into the
  // artifact so the Cost panel populates on both the local and imported DB.
  const emitEvent = async (
    agent: AgentEventRow['agent'],
    traceId: string,
    eventType: string,
    costUsd: number,
    payload?: unknown,
  ) => {
    const createdAt = new Date(params.clock.now()).toISOString()
    await params.repo.insertAgentEvent({ traceId, agent, eventType, costUsd, createdAt, ...(payload === undefined ? {} : { payload }) })
    artifactEvents.push({ trace_id: traceId, agent, event_type: eventType, cost_usd: Number(costUsd.toFixed(6)), created_at: createdAt, ...(payload === undefined ? {} : { payload }) })
  }

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
    // Artifact accumulation for this campaign (transcript.attempt_id id-space).
    const campaignAttempts: RunArtifactAttempt[] = []
    const rootTranscriptIdBySeed = new Map<string, string>()
    const campaignPlan: CampaignPlan = buildCampaignPlan(item, seeds, params, campaignId, startedAtIso)
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

      // Per-role spend: the Co-Pilot's own model spend (agent='target') and the
      // Judge's spend (agent='judge', zero when a detector was authoritative).
      await emitEvent('target', detail.transcript.trace_id, 'answer', attemptTargetCost, {
        attempt_id: detail.transcript.attempt_id,
        tokens: detail.transcript.totals.input_tokens + detail.transcript.totals.output_tokens,
      })
      await emitEvent('judge', detail.transcript.trace_id, verdict.stage, judgeCost, {
        attempt_id: detail.transcript.attempt_id,
        outcome: verdict.outcome,
      })

      // Mirror the attempt into the run artifact (id-space: transcript.attempt_id).
      if (item.subcategory) {
        const parentTranscriptId = detail.isSeed ? undefined : rootTranscriptIdBySeed.get(detail.seedId)
        campaignAttempts.push({
          transcript: detail.transcript,
          ...(parentTranscriptId ? { parent_attempt_id: parentTranscriptId } : {}),
          fingerprint: detail.fingerprint,
          category: item.category,
          subcategory: item.subcategory,
          owasp_ids: seedOwaspFor(detail.seedId),
          technique_tags: [detail.family],
          tokens: detail.transcript.totals.input_tokens + detail.transcript.totals.output_tokens,
          cost_usd: attemptCost,
          verdicts: [verdict],
        })
        if (detail.isSeed) rootTranscriptIdBySeed.set(detail.seedId, detail.transcript.attempt_id)
      }

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
          if (!artifactExploits.has(detail.fingerprint)) {
            artifactExploits.set(detail.fingerprint, {
              id: `AF-${new Date(params.clock.now()).getFullYear()}-${detail.fingerprint.slice(0, 8)}`,
              fingerprint: detail.fingerprint,
              severity: (SEVERITY_BY_CATEGORY[item.category] ?? 'medium') as RunArtifactExploit['severity'],
              category: item.category,
              subcategory: item.subcategory,
              owasp_ids: seedOwaspFor(detail.seedId),
              min_repro: { turns: detail.transcript.turns.map((t) => t.attacker_message), attempt_id: detail.transcript.attempt_id },
              family_ids: [],
            })
          }
        }
        coverage.set(key, entry)
      }
    }

    // Red Team spend for the campaign: deterministic mutation is free; this row
    // is the per-role marker (model-variant cost would accrue here when wired).
    await emitEvent('redteam', campaignPlan.trace_id, 'generate', 0, {
      campaign_id: campaignId,
      attempts: campaign.attempts,
      refusal_rate: campaign.refusalRate,
    })

    await params.repo.updateCampaign(campaignId, { spendUsd: campaignSpend, status: aborted ? 'aborted' : 'completed' })
    artifactCampaigns.push({
      plan: campaignPlan,
      spend_usd: Number(campaignSpend.toFixed(6)),
      status: aborted ? 'aborted' : 'completed',
      attempts: campaignAttempts,
    })
  }

  // Materialize coverage_snapshots (assert the cell before insert; ARCHITECTURE 7.5).
  const artifactCoverage: RunArtifactCoverage[] = []
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
    artifactCoverage.push({
      category,
      subcategory,
      attempts: entry.attempts,
      confirmed: entry.confirmed,
      families_exercised: entry.roots.size,
      last_run_at: entry.lastRunAt,
    })
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

  const artifact: RunArtifact = {
    schema_version: '1',
    run_key: params.plan.trace_id,
    trigger: params.plan.trigger,
    status,
    started_at: startedAtIso,
    finished_at: summary.generated_at,
    target: { name: 'copilot', base_url: params.targetBaseUrl, version: params.plan.target_version },
    spend_usd: Number(spendUsd.toFixed(6)),
    summary,
    campaigns: artifactCampaigns,
    exploits: [...artifactExploits.values()],
    agent_events: artifactEvents,
    coverage: artifactCoverage,
    queue_request_ids: params.plan.items
      .filter((i) => i.kind === 'operator_request' && i.request_id && i.decision === 'run' && !aborted)
      .map((i) => i.request_id!),
  }

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
    artifact,
  }
}

/** Builds a valid CampaignPlan v1 for the run artifact from a plan item + seeds. */
function buildCampaignPlan(
  item: NightlyPlanItem,
  seeds: CampaignSeed[],
  params: RunPlanParams,
  campaignId: string,
  producedAt: string,
): CampaignPlan {
  const uniq = (xs: string[]) => [...new Set(xs)]
  const owaspLlm = uniq(seeds.flatMap((s) => s.owasp_llm_ids ?? []))
  const owaspWeb = uniq(seeds.flatMap((s) => s.owasp_ids ?? []))
  return {
    schema_version: '1',
    message_id: params.clock.randomUUID(),
    campaign_id: campaignId,
    trace_id: `${params.plan.trace_id}:${item.item_id}`,
    produced_by: 'orchestrator',
    produced_at: producedAt,
    category: item.category,
    ...(item.subcategory ? { subcategory: item.subcategory } : {}),
    owasp_llm_ids: owaspLlm.length > 0 ? owaspLlm : ['LLM01'],
    owasp_ids: owaspWeb.length > 0 ? owaspWeb : ['A01'],
    seed_case_ids: item.seed_case_ids,
    max_attempts: item.max_attempts,
    max_turns: Math.max(1, ...seeds.map((s) => s.turns.length)),
    budget: { tokens: 0, usd: item.estimated_cost_usd },
    target_version: params.plan.target_version,
  }
}

function recordGeneration(trace: TraceScope, stage: string, outcome: string, modelId: string): void {
  trace.generation({
    name: `judge:${stage}`,
    model: stage === 'detector' ? 'detectors' : modelId,
    output: { outcome, stage },
  })
}

/** The dashboard's stored run_now plan jsonb shape (agentforge-8 seam). */
export interface RunNowScope {
  kind: 'queue' | 'single'
  operatorRequestId?: string
}
interface StoredRunNowPlan {
  scope?: RunNowScope
  requested_by?: string
  requested_at?: string
}

export interface RunScheduledParams extends Omit<RunPlanParams, 'plan' | 'scheduledFor'> {
  /** Priority weights for any coverage campaigns the scope allows. */
  weights: import('@agentforge/contracts').PriorityTerms
  costPerAttemptUsd: number
  maxAttemptsPerCampaign: number
  topK: number
  /** Coverage inputs (optional; the button scope is operator-request-driven). */
  coverageCells?: import('./priority.js').CoverageCellInput[]
  seedsByCell?: Record<string, string[]>
  runDate: string
  targetVersion: string
  /** Claim a specific scheduled row; otherwise the oldest is claimed. */
  claimId?: number
}

/**
 * Consumes a `scheduled` `run_now` row the dashboard inserted (agentforge-8's
 * "Run now" button). It claims the row, reads its `plan.scope`, drains the
 * matching operator_requests (all queued, or a single id), resolves each rerun
 * to the exploit's stored minimal reproduction so it can be replayed, builds a
 * NightlyPlan, and executes it against the already-claimed row. Returns null when
 * there is no scheduled row to claim. This shares the {@link executePlan} core
 * with the CLI Run-now, so button and CLI take one path.
 */
export async function runScheduledRunNow(params: RunScheduledParams): Promise<RunPlanResult | null> {
  const claimed = await params.repo.claimRunNow(params.claimId)
  if (claimed === null) {
    return null
  }
  const stored = (typeof claimed.plan === 'object' && claimed.plan !== null ? claimed.plan : {}) as StoredRunNowPlan
  const scope: RunNowScope = stored.scope ?? { kind: 'queue' }

  try {
    const targetVersionId = await params.repo.ensureTargetVersion(params.targetBaseUrl, params.targetVersion)
    const requests = await params.repo.drainOperatorRequests(
      params.runDate,
      scope.kind === 'single' ? scope.operatorRequestId : undefined,
    )

    // Resolve reruns to their exploit reproduction so they can be replayed.
    const seedsById = new Map(params.seedsById)
    const seedsByCell: Record<string, string[]> = { ...(params.seedsByCell ?? {}) }
    const enrichedRequests: QueuedRequest[] = []
    for (const req of requests) {
      if (req.kind === 'rerun' && req.exploit_id) {
        const repro = await params.repo.getExploitReproduction(req.exploit_id)
        if (repro && repro.turns.length > 0) {
          const sub = repro.subcategory ?? 'direct'
          const key = `${repro.category}/${sub}`
          seedsById.set(req.exploit_id, {
            id: req.exploit_id,
            category: repro.category,
            subcategory: sub,
            session_role: 'clinician',
            turns: repro.turns,
            technique_tags: ['rerun'],
          })
          seedsByCell[key] = [...(seedsByCell[key] ?? []), req.exploit_id]
          enrichedRequests.push({ ...req, category: repro.category, subcategory: sub })
          continue
        }
      }
      enrichedRequests.push(req)
    }

    const plan = buildNightlyPlan({
      trigger: 'run_now',
      targetVersion: params.targetVersion,
      budgetUsd: params.spendCapUsd,
      weights: params.weights,
      operatorRequests: enrichedRequests,
      coverageCells: params.coverageCells ?? [],
      seedsByCell,
      costPerAttemptUsd: params.costPerAttemptUsd,
      maxAttemptsPerCampaign: params.maxAttemptsPerCampaign,
      topK: params.topK,
      traceId: `runnow-${claimed.nightlyRunId}`,
      now: new Date(params.clock.now()),
    })

    return await executePlan({ ...params, plan, seedsById }, claimed.nightlyRunId, targetVersionId)
  } catch (error) {
    // Mark the claimed row failed so it does not sit stuck in `running`.
    const summary: NightlyRunSummary = {
      target_version: params.targetVersion,
      headline: `Run failed: ${error instanceof Error ? error.message : 'unknown error'}`,
      new_tickets: [],
      regressions: [],
      verified_fixes: [],
      queue: { ran: 0, cut: 0 },
      notes: ['Aborted by an error before completion.'],
      generated_at: new Date(params.clock.now()).toISOString(),
    }
    await params.repo.finishNightlyRun(claimed.nightlyRunId, { summary, spendUsd: 0, status: 'failed' })
    throw error
  }
}
