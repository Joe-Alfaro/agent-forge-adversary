import type { NightlyRunSummary } from '@agentforge/contracts'
import type pg from 'pg'

import { recomputeCoverage } from './coverage.js'

/**
 * The normalized form every importer produces (live eval files, run
 * artifacts), written by one transactional, idempotent writer. The dashboard
 * reads exactly these tables (ARCHITECTURE.md Section 14.3).
 */
export interface ImportPlan {
  /** Stored as nightly_runs.plan.import_key; a second import with the same key is a no-op. */
  importKey: string
  kind: 'live_eval' | 'run_artifact'
  target: { name: string; base_url: string; version: string }
  run: {
    startedAt: string
    finishedAt: string
    trigger: 'run_now' | 'cron'
    status: 'completed' | 'failed' | 'aborted'
    spendUsd: number
    summary: NightlyRunSummary
  }
  campaigns: PlannedCampaign[]
  attempts: PlannedAttempt[]
  exploits: PlannedExploit[]
  events: PlannedEvent[]
  /**
   * The emitter's coverage rows, validated but not written: the writer
   * recomputes coverage_snapshots from the destination database instead.
   */
  coverage: PlannedCoverage[] | null
  /** Operator requests this run drained; marked `ran` and linked to the run. */
  requestIds: string[]
}

export interface PlannedCampaign {
  id: string
  plan: unknown
  budgetUsd: number
  spendUsd: number
  status: string
  startedAt: string
}

export interface PlannedVerdict {
  outcome: 'success' | 'partial' | 'fail'
  confidence: number
  stage: string
  rubricVersion: string
  judgeModel: string | null
  evidence: unknown[]
  needsReview: boolean
  createdAt: string
}

export interface PlannedAttempt {
  id: string
  campaignId: string
  parentAttemptId: string | null
  fingerprint: string
  category: string
  subcategory: string
  owaspIds: string[]
  techniqueTags: string[]
  transcript: unknown
  tokens: number
  costUsd: number
  createdAt: string
  verdicts: PlannedVerdict[]
}

export interface PlannedExploit {
  fingerprint: string
  severity: string
  category: string
  subcategory: string
  owaspIds: string[]
  minRepro: unknown
  familyIds: string[]
  report: unknown
}

export interface PlannedEvent {
  traceId: string
  agent: string
  eventType: string
  payload: unknown
  source: string
  costUsd: number
  createdAt: string
}

export interface PlannedCoverage {
  category: string
  subcategory: string
  attempts: number
  confirmed: number
  familiesExercised: number
  lastRunAt: string | null
}

export type ImportResult = { status: 'imported' | 'already_imported'; runId: number }

async function sequentially<T>(items: T[], write: (item: T) => Promise<unknown>) {
  // One client cannot run queries concurrently.
  await items.reduce(async (previous, item) => {
    await previous
    await write(item)
  }, Promise.resolve())
}

export async function importPlan(pool: pg.Pool, plan: ImportPlan): Promise<ImportResult> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    // Serialize concurrent imports of the same key.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [plan.importKey])
    const existing = await client.query<{ id: number }>(`SELECT id FROM nightly_runs WHERE plan->>'import_key' = $1`, [
      plan.importKey,
    ])
    if (existing.rows[0]) {
      await client.query('ROLLBACK')
      return { status: 'already_imported', runId: existing.rows[0].id }
    }

    const target = await client.query<{ id: number }>(
      `INSERT INTO targets (base_url, kind, allowlisted_by) VALUES ($1, $2, 'importer')
       ON CONFLICT (base_url) DO UPDATE SET base_url = EXCLUDED.base_url RETURNING id`,
      [plan.target.base_url, plan.target.name],
    )
    const version = await client.query<{ id: number }>(
      `INSERT INTO target_versions (target_id, version, first_seen) VALUES ($1, $2, $3)
       ON CONFLICT (target_id, version) DO UPDATE SET version = EXCLUDED.version RETURNING id`,
      [target.rows[0]!.id, plan.target.version, plan.run.startedAt],
    )
    const versionId = version.rows[0]!.id

    const run = await client.query<{ id: number }>(
      `INSERT INTO nightly_runs (scheduled_for, started_at, finished_at, trigger, plan, summary, spend_usd, status)
       VALUES ($1, $1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [
        plan.run.startedAt,
        plan.run.finishedAt,
        plan.run.trigger,
        { import_key: plan.importKey, kind: plan.kind },
        plan.run.summary,
        plan.run.spendUsd,
        plan.run.status,
      ],
    )
    const runId = run.rows[0]!.id

    await sequentially(plan.campaigns, (campaign) =>
      client.query(
        `INSERT INTO campaigns (id, nightly_run_id, plan, budget_usd, spend_usd, status, started_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [campaign.id, runId, JSON.stringify(campaign.plan), campaign.budgetUsd, campaign.spendUsd, campaign.status, campaign.startedAt],
      ),
    )

    // Parents are linked after every attempt exists, so artifact order does not matter.
    await sequentially(plan.attempts, async (attempt) => {
      await client.query(
        `INSERT INTO attempts (id, campaign_id, fingerprint, category, subcategory, owasp_ids, technique_tags,
                               transcript, target_version_id, tokens, cost_usd, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [
          attempt.id, attempt.campaignId, attempt.fingerprint, attempt.category, attempt.subcategory, attempt.owaspIds,
          attempt.techniqueTags, JSON.stringify(attempt.transcript), versionId, attempt.tokens, attempt.costUsd, attempt.createdAt,
        ],
      )
      await sequentially(attempt.verdicts, (verdict) =>
        client.query(
          `INSERT INTO verdicts (attempt_id, outcome, confidence, stage, rubric_version, judge_model, evidence, needs_review, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            attempt.id, verdict.outcome, verdict.confidence, verdict.stage, verdict.rubricVersion, verdict.judgeModel,
            JSON.stringify(verdict.evidence), verdict.needsReview, verdict.createdAt,
          ],
        ),
      )
    })
    await sequentially(
      plan.attempts.filter((attempt) => attempt.parentAttemptId !== null),
      (attempt) => client.query('UPDATE attempts SET parent_attempt_id = $2 WHERE id = $1', [attempt.id, attempt.parentAttemptId]),
    )

    // Ids come from agentforge_exploit_seq, in the same format the run executor
    // mints, so every writer shares one id space. A re-found exploit keeps its
    // id and merges its family; the operator's status and assignee are never touched.
    const newTicketIds: string[] = []
    await sequentially(plan.exploits, async (exploit) => {
      const upserted = await client.query<{ id: string; is_new: boolean }>(
        `INSERT INTO exploits (id, fingerprint, severity, category, subcategory, owasp_ids, min_repro, family_ids, discovered_version_id)
         VALUES ('AF-' || to_char(now(), 'YYYY') || '-' || lpad(nextval('agentforge_exploit_seq')::text, 4, '0'),
                 $1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (fingerprint) DO UPDATE
           SET family_ids = ARRAY(SELECT DISTINCT unnest(exploits.family_ids || EXCLUDED.family_ids)),
               updated_at = now()
         RETURNING id, (xmax = 0) AS is_new`,
        [
          exploit.fingerprint, exploit.severity, exploit.category, exploit.subcategory, exploit.owaspIds,
          JSON.stringify(exploit.minRepro), exploit.familyIds, versionId,
        ],
      )
      if (upserted.rows[0]?.is_new) {
        newTicketIds.push(upserted.rows[0].id)
      }
      if (exploit.report !== null) {
        await client.query(
          `INSERT INTO reports (exploit_id, body)
           SELECT id, $2 FROM exploits WHERE fingerprint = $1
             AND NOT EXISTS (SELECT 1 FROM reports r WHERE r.exploit_id = exploits.id)`,
          [exploit.fingerprint, JSON.stringify(exploit.report)],
        )
      }
    })

    // The artifact cannot know the assigned ids, so the writer owns new_tickets.
    await client.query(
      `UPDATE nightly_runs SET summary = jsonb_set(summary, '{new_tickets}', $2::jsonb) WHERE id = $1`,
      [runId, JSON.stringify(newTicketIds)],
    )

    await sequentially(plan.events, (event) =>
      client.query(
        `INSERT INTO agent_events (trace_id, agent, event_type, payload, source, cost_usd, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [event.traceId, event.agent, event.eventType, JSON.stringify(event.payload), event.source, event.costUsd, event.createdAt],
      ),
    )

    // Counted here, from this database, after the new attempts and exploits are in.
    await recomputeCoverage(client, versionId)

    if (plan.requestIds.length > 0) {
      await client.query(
        `UPDATE operator_requests SET status = 'ran', nightly_run_id = $2 WHERE id = ANY($1::uuid[]) AND status = 'queued'`,
        [plan.requestIds, runId],
      )
    }

    await client.query('COMMIT')
    return { status: 'imported', runId }
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}
