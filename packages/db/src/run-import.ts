import {
  isTaxonomyCell,
  validateAttackTranscript,
  validateCampaignPlan,
  validateNightlyRunSummary,
  validateVerdict,
  type AttackTranscript,
  type CampaignPlan,
  type NightlyRunSummary,
  type ValidationResult,
  type Verdict,
} from '@agentforge/contracts'

import type { ImportPlan, PlannedAttempt } from './import-writer.js'

/**
 * The artifact a campaign or nightly run emits for import into the platform
 * database (`npm run db:import-run -- <file>`). Contract objects inside it
 * (CampaignPlan, AttackTranscript, Verdict, NightlyRunSummary v1) are validated
 * as they are; the rest mirrors the tables in ARCHITECTURE.md Section 14.3.
 */
export interface RunArtifact {
  schema_version: '1'
  /** Unique per run; importing the same key twice is a no-op. */
  run_key: string
  trigger: 'run_now' | 'cron'
  status: 'completed' | 'failed' | 'aborted'
  started_at: string
  finished_at: string
  target: { name: string; base_url: string; version: string }
  spend_usd: number
  summary?: NightlyRunSummary
  campaigns: RunArtifactCampaign[]
  exploits?: RunArtifactExploit[]
  agent_events?: RunArtifactEvent[]
  coverage?: RunArtifactCoverage[]
  /** Operator requests the run drained. */
  queue_request_ids?: string[]
}

export interface RunArtifactCampaign {
  plan: CampaignPlan
  spend_usd: number
  status: string
  attempts: RunArtifactAttempt[]
}

export interface RunArtifactAttempt {
  transcript: AttackTranscript
  parent_attempt_id?: string
  fingerprint: string
  category: string
  subcategory: string
  owasp_ids: string[]
  technique_tags?: string[]
  tokens?: number
  cost_usd?: number
  verdicts: Verdict[]
}

export interface RunArtifactExploit {
  id: string
  fingerprint: string
  severity: 'critical' | 'high' | 'medium' | 'low'
  category: string
  subcategory: string
  owasp_ids: string[]
  min_repro: unknown
  family_ids: string[]
  report?: { body: unknown }
}

export interface RunArtifactEvent {
  trace_id: string
  agent: string
  event_type: string
  payload?: unknown
  cost_usd: number
  created_at: string
}

export interface RunArtifactCoverage {
  category: string
  subcategory: string
  attempts: number
  confirmed: number
  families_exercised: number
  last_run_at?: string
}

function check<T>(path: string, result: ValidationResult<T>): T {
  if (!result.valid) {
    throw new Error(`${path} is invalid: ${result.errors.join('; ')}`)
  }
  return result.value as T
}

function checkCell(path: string, category: string, subcategory: string) {
  if (!isTaxonomyCell(category, subcategory)) {
    throw new Error(`${path}: ${category}/${subcategory} is not an AttackTaxonomy v1 cell`)
  }
}

function deriveSummary(artifact: RunArtifact, attempts: PlannedAttempt[]): NightlyRunSummary {
  const latest = attempts.map((attempt) => attempt.verdicts.at(-1)?.outcome)
  const confirmed = latest.filter((outcome) => outcome === 'success').length
  return {
    target_version: artifact.target.version,
    headline: `${artifact.trigger === 'cron' ? 'Nightly run' : 'Run now'} against ${artifact.target.version}: ${attempts.length} attempts, ${confirmed} confirmed.`,
    new_tickets: (artifact.exploits ?? []).map((exploit) => exploit.id),
    regressions: [],
    verified_fixes: [],
    queue: { ran: artifact.queue_request_ids?.length ?? 0, cut: 0 },
    notes: [],
    generated_at: artifact.finished_at,
  }
}

export function planRunImport(artifact: RunArtifact): ImportPlan {
  if (artifact.schema_version !== '1') {
    throw new Error(`Unsupported run artifact schema_version "${artifact.schema_version}"`)
  }

  const attempts = artifact.campaigns.flatMap((campaign, c) => {
    const plan = check(`campaigns[${c}].plan`, validateCampaignPlan(campaign.plan))
    return campaign.attempts.map((attempt, a): PlannedAttempt => {
      const path = `campaigns[${c}].attempts[${a}]`
      const transcript = check(`${path}.transcript`, validateAttackTranscript(attempt.transcript))
      if (transcript.campaign_id !== plan.campaign_id) {
        throw new Error(`${path}: transcript campaign ${transcript.campaign_id} is not campaign ${plan.campaign_id}`)
      }
      checkCell(path, attempt.category, attempt.subcategory)
      const verdicts = attempt.verdicts.map((raw, v) => {
        const verdict = check(`${path}.verdicts[${v}]`, validateVerdict(raw))
        if (verdict.attempt_id !== transcript.attempt_id) {
          throw new Error(`${path}.verdicts[${v}]: verdict is for attempt ${verdict.attempt_id}`)
        }
        return {
          outcome: verdict.outcome,
          confidence: verdict.confidence,
          stage: verdict.stage,
          rubricVersion: verdict.rubric_version,
          judgeModel: verdict.judge_model ?? null,
          evidence: verdict.evidence,
          needsReview: verdict.needs_review,
          createdAt: verdict.produced_at,
        }
      })
      return {
        id: transcript.attempt_id,
        campaignId: plan.campaign_id,
        parentAttemptId: attempt.parent_attempt_id ?? null,
        fingerprint: attempt.fingerprint,
        category: attempt.category,
        subcategory: attempt.subcategory,
        owaspIds: attempt.owasp_ids,
        techniqueTags: attempt.technique_tags ?? [],
        transcript,
        tokens: attempt.tokens ?? 0,
        costUsd: attempt.cost_usd ?? 0,
        createdAt: transcript.produced_at,
        verdicts,
      }
    })
  })

  const exploits = (artifact.exploits ?? []).map((exploit, e) => {
    checkCell(`exploits[${e}]`, exploit.category, exploit.subcategory)
    return {
      id: exploit.id,
      fingerprint: exploit.fingerprint,
      severity: exploit.severity,
      category: exploit.category,
      subcategory: exploit.subcategory,
      owaspIds: exploit.owasp_ids,
      minRepro: exploit.min_repro,
      familyIds: exploit.family_ids,
      report: exploit.report?.body ?? null,
    }
  })

  const coverage = artifact.coverage?.map((cell, i) => {
    checkCell(`coverage[${i}]`, cell.category, cell.subcategory)
    return {
      category: cell.category,
      subcategory: cell.subcategory,
      attempts: cell.attempts,
      confirmed: cell.confirmed,
      familiesExercised: cell.families_exercised,
      lastRunAt: cell.last_run_at ?? null,
    }
  })

  const summary = artifact.summary
    ? check('summary', validateNightlyRunSummary(artifact.summary))
    : deriveSummary(artifact, attempts)

  return {
    importKey: `run-import:${artifact.run_key}`,
    kind: 'run_artifact',
    target: artifact.target,
    run: {
      startedAt: artifact.started_at,
      finishedAt: artifact.finished_at,
      trigger: artifact.trigger,
      status: artifact.status,
      spendUsd: artifact.spend_usd,
      summary,
    },
    campaigns: artifact.campaigns.map((campaign) => ({
      id: campaign.plan.campaign_id,
      plan: campaign.plan,
      budgetUsd: campaign.plan.budget.usd,
      spendUsd: campaign.spend_usd,
      status: campaign.status,
      startedAt: campaign.plan.produced_at,
    })),
    attempts,
    exploits,
    events: (artifact.agent_events ?? []).map((event) => ({
      traceId: event.trace_id,
      agent: event.agent,
      eventType: event.event_type,
      payload: event.payload ?? null,
      source: 'run_import',
      costUsd: event.cost_usd,
      createdAt: event.created_at,
    })),
    coverage: coverage ?? null,
    requestIds: artifact.queue_request_ids ?? [],
  }
}
