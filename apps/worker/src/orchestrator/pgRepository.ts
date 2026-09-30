import type pg from 'pg'

import { listTaxonomyCells } from '@agentforge/contracts'

import type { CoverageCellInput, Severity } from './priority.js'
import type { QueuedRequest } from './planner.js'
import type {
  AttemptRow,
  CoverageSnapshotRow,
  ExploitRow,
  OrchestratorRepository,
  VerdictRow,
} from './repository.js'

/**
 * The Postgres implementation of the Orchestrator repository, plus the read
 * queries the Run-now entrypoint uses to build a plan (drain the operator queue,
 * derive coverage cells). It uses the shared `pg` types structurally so the
 * worker does not take a hard dependency on a pool implementation; the executor
 * itself is tested offline against the in-memory fake.
 */

type Queryable = Pick<pg.Pool, 'query'>

const TARGET_ATTEMPTS = 10

export class PgOrchestratorRepository implements OrchestratorRepository {
  constructor(private readonly pool: Queryable) {}

  async ensureTargetVersion(baseUrl: string, version: string): Promise<number> {
    await this.pool.query(
      `INSERT INTO targets (base_url, kind, allowlisted_by) VALUES ($1, 'copilot', 'orchestrator')
       ON CONFLICT (base_url) DO NOTHING`,
      [baseUrl],
    )
    const target = await this.pool.query('SELECT id FROM targets WHERE base_url = $1', [baseUrl])
    const targetId = target.rows[0]?.id as number
    await this.pool.query(
      `INSERT INTO target_versions (target_id, version) VALUES ($1, $2)
       ON CONFLICT (target_id, version) DO NOTHING`,
      [targetId, version],
    )
    const tv = await this.pool.query('SELECT id FROM target_versions WHERE target_id = $1 AND version = $2', [targetId, version])
    return tv.rows[0]?.id as number
  }

  async createNightlyRun(row: { scheduledFor: string; trigger: 'cron' | 'run_now'; plan: unknown }): Promise<number> {
    const result = await this.pool.query(
      `INSERT INTO nightly_runs (scheduled_for, started_at, trigger, plan, status)
       VALUES ($1, now(), $2, $3, 'running') RETURNING id`,
      [row.scheduledFor, row.trigger, JSON.stringify(row.plan)],
    )
    return result.rows[0]?.id as number
  }

  async createCampaign(row: { nightlyRunId: number; plan: unknown; budgetUsd: number }): Promise<string> {
    const result = await this.pool.query(
      `INSERT INTO campaigns (nightly_run_id, plan, budget_usd, status)
       VALUES ($1, $2, $3, 'running') RETURNING id`,
      [row.nightlyRunId, JSON.stringify(row.plan), row.budgetUsd],
    )
    return result.rows[0]?.id as string
  }

  async insertAttempt(row: AttemptRow): Promise<string> {
    const result = await this.pool.query(
      `INSERT INTO attempts
        (campaign_id, parent_attempt_id, fingerprint, category, subcategory, owasp_ids, technique_tags, transcript, target_version_id, tokens, cost_usd)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [
        row.campaignId,
        row.parentAttemptId ?? null,
        row.fingerprint,
        row.category,
        row.subcategory ?? null,
        row.owaspIds,
        row.techniqueTags,
        JSON.stringify(row.transcript),
        row.targetVersionId,
        row.tokens,
        row.costUsd,
      ],
    )
    return result.rows[0]?.id as string
  }

  async insertVerdict(row: VerdictRow): Promise<void> {
    const v = row.verdict
    await this.pool.query(
      `INSERT INTO verdicts (attempt_id, outcome, confidence, stage, rubric_version, judge_model, evidence, needs_review)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [row.attemptId, v.outcome, v.confidence, v.stage, v.rubric_version, v.judge_model ?? null, JSON.stringify(v.evidence), v.needs_review],
    )
  }

  async upsertExploit(row: ExploitRow): Promise<{ id: string; isNew: boolean }> {
    const result = await this.pool.query(
      `INSERT INTO exploits (id, fingerprint, severity, category, subcategory, owasp_ids, min_repro, discovered_version_id, family_ids)
       VALUES ('AF-' || to_char(now(), 'YYYY') || '-' || lpad(nextval('agentforge_exploit_seq')::text, 4, '0'),
               $1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (fingerprint) DO UPDATE SET updated_at = now()
       RETURNING id, (xmax = 0) AS is_new`,
      [
        row.fingerprint,
        row.severity,
        row.category,
        row.subcategory ?? null,
        row.owaspIds,
        JSON.stringify(row.minRepro),
        row.discoveredVersionId,
        row.familyIds,
      ],
    )
    return { id: result.rows[0]?.id as string, isNew: Boolean(result.rows[0]?.is_new) }
  }

  async upsertCoverageSnapshot(row: CoverageSnapshotRow): Promise<void> {
    await this.pool.query(
      `INSERT INTO coverage_snapshots (target_version_id, category, subcategory, attempts, confirmed, families_exercised, last_run_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (target_version_id, category, subcategory)
       DO UPDATE SET attempts = EXCLUDED.attempts, confirmed = EXCLUDED.confirmed,
                     families_exercised = EXCLUDED.families_exercised, last_run_at = EXCLUDED.last_run_at`,
      [row.targetVersionId, row.category, row.subcategory, row.attempts, row.confirmed, row.familiesExercised, row.lastRunAt],
    )
  }

  async updateCampaign(id: string, args: { spendUsd: number; status: string }): Promise<void> {
    await this.pool.query('UPDATE campaigns SET spend_usd = $2, status = $3 WHERE id = $1', [id, args.spendUsd, args.status])
  }

  async finishNightlyRun(id: number, args: { summary: unknown; spendUsd: number; status: string }): Promise<void> {
    await this.pool.query(
      `UPDATE nightly_runs SET summary = $2, spend_usd = $3, status = $4, finished_at = now() WHERE id = $1`,
      [id, JSON.stringify(args.summary), args.spendUsd, args.status],
    )
  }

  async setRequestStatus(id: string, status: 'ran' | 'cut', nightlyRunId: number): Promise<void> {
    await this.pool.query('UPDATE operator_requests SET status = $2, nightly_run_id = $3 WHERE id = $1', [id, status, nightlyRunId])
  }

  // ---- Read side, used by the Run-now entrypoint to build a plan ----

  /** Drains the operator queue in the documented order: position NULLS LAST, created_at. */
  async drainQueue(runDate: string): Promise<QueuedRequest[]> {
    const result = await this.pool.query(
      `SELECT id, kind, exploit_id, category, reason
       FROM operator_requests
       WHERE status = 'queued' AND (requested_for IS NULL OR requested_for <= $1)
       ORDER BY position NULLS LAST, created_at, id`,
      [runDate],
    )
    return result.rows.map((r) => ({
      id: String(r.id),
      kind: r.kind,
      ...(r.exploit_id ? { exploit_id: String(r.exploit_id) } : {}),
      ...(r.category ? { category: String(r.category) } : {}),
      ...(r.reason ? { reason: String(r.reason) } : {}),
    }))
  }

  /**
   * Derives a priority input per taxonomy cell for the current target version:
   * attempts and staleness from `attempts`, open-finding severities and recent
   * regressions from `exploits`. Signal-per-dollar is left at 0 (populated once
   * a trailing-window metric exists) and predicted cost is a flat estimate.
   */
  async getCoverageCells(targetVersionId: number, predictedCostUsd: number): Promise<CoverageCellInput[]> {
    const attemptsByCell = await this.pool.query(
      `SELECT category, COALESCE(subcategory, '') AS subcategory,
              count(*) AS attempts,
              EXTRACT(EPOCH FROM (now() - max(created_at))) / 86400.0 AS days_since
       FROM attempts WHERE target_version_id = $1
       GROUP BY category, COALESCE(subcategory, '')`,
      [targetVersionId],
    )
    const openByCell = await this.pool.query(
      `SELECT category, COALESCE(subcategory, '') AS subcategory, severity,
              count(*) FILTER (WHERE status = 'regressed') AS regressed
       FROM exploits WHERE status IN ('open', 'in_progress', 'regressed')
       GROUP BY category, COALESCE(subcategory, ''), severity`,
    )

    const attemptsMap = new Map<string, { attempts: number; daysSince: number }>()
    attemptsByCell.rows.forEach((r) =>
      attemptsMap.set(`${r.category}/${r.subcategory}`, { attempts: Number(r.attempts), daysSince: Number(r.days_since) }),
    )
    const openMap = new Map<string, { findings: { severity: Severity }[]; regressed: boolean }>()
    openByCell.rows.forEach((r) => {
      const key = `${r.category}/${r.subcategory}`
      const entry = openMap.get(key) ?? { findings: [], regressed: false }
      entry.findings.push({ severity: r.severity as Severity })
      if (Number(r.regressed) > 0) entry.regressed = true
      openMap.set(key, entry)
    })

    return listTaxonomyCells().map((cell) => {
      const key = `${cell.category}/${cell.subcategory}`
      const a = attemptsMap.get(key)
      const o = openMap.get(key)
      return {
        category: cell.category,
        subcategory: cell.subcategory,
        attempts: a?.attempts ?? 0,
        targetAttempts: TARGET_ATTEMPTS,
        openFindings: o?.findings ?? [],
        regressedThisVersion: o?.regressed ?? false,
        recentSignalPerDollar: 0,
        daysSinceLastRun: a ? a.daysSince : STALE_WHEN_NEVER_RUN,
        predictedCostUsd,
      }
    })
  }
}

/** A never-run cell is maximally stale so it is preferred by the priority score. */
const STALE_WHEN_NEVER_RUN = 30
