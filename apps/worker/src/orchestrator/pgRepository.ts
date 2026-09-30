import type pg from 'pg'

import { listTaxonomyCells } from '@agentforge/contracts'

import type { CoverageCellInput, Severity } from './priority.js'
import type { QueuedRequest, RegressionOwed } from './planner.js'
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

  async insertAgentEvent(row: import('./repository.js').AgentEventRow): Promise<void> {
    await this.pool.query(
      `INSERT INTO agent_events (trace_id, agent, event_type, payload, source, cost_usd, created_at)
       VALUES ($1, $2, $3, $4, 'orchestrator_run', $5, $6)`,
      [row.traceId, row.agent, row.eventType, row.payload === undefined ? null : JSON.stringify(row.payload), row.costUsd, row.createdAt],
    )
  }

  async upsertExploit(row: ExploitRow): Promise<{ id: string; isNew: boolean }> {
    // Conflict behavior is kept identical to packages/db import-writer.ts (the
    // shared row-shape authority): a re-found exploit merges its family_ids and
    // never touches the operator's status or assignee.
    const result = await this.pool.query(
      `INSERT INTO exploits (id, fingerprint, severity, category, subcategory, owasp_ids, min_repro, discovered_version_id, family_ids)
       VALUES ('AF-' || to_char(now(), 'YYYY') || '-' || lpad(nextval('agentforge_exploit_seq')::text, 4, '0'),
               $1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (fingerprint) DO UPDATE
         SET family_ids = ARRAY(SELECT DISTINCT unnest(exploits.family_ids || EXCLUDED.family_ids)),
             updated_at = now()
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

  async claimRunNow(id?: number): Promise<{ nightlyRunId: number; plan: unknown } | null> {
    const result = await this.pool.query(
      `UPDATE nightly_runs SET status = 'running', started_at = now()
       WHERE id = (
         SELECT id FROM nightly_runs
         WHERE trigger = 'run_now' AND status = 'scheduled'${id === undefined ? '' : ' AND id = $1'}
         ORDER BY scheduled_for, id
         FOR UPDATE SKIP LOCKED
         LIMIT 1
       )
       RETURNING id, plan`,
      id === undefined ? [] : [id],
    )
    const row = result.rows[0]
    if (!row) return null
    return { nightlyRunId: Number(row.id), plan: row.plan }
  }

  async getExploitReproduction(exploitId: string): Promise<{ category: string; subcategory?: string; turns: string[] } | null> {
    const result = await this.pool.query('SELECT category, subcategory, min_repro FROM exploits WHERE id = $1', [exploitId])
    const row = result.rows[0]
    if (!row) return null
    const repro = row.min_repro as { turns?: unknown } | null
    const turns = Array.isArray(repro?.turns) ? repro.turns.filter((t): t is string => typeof t === 'string') : []
    return {
      category: String(row.category),
      ...(row.subcategory ? { subcategory: String(row.subcategory) } : {}),
      turns,
    }
  }

  // ---- Read side, used by the Run-now entrypoint to build a plan ----

  /** Drains the operator queue in the documented order: position NULLS LAST, created_at. */
  async drainOperatorRequests(runDate: string, singleId?: string): Promise<QueuedRequest[]> {
    const result = await this.pool.query(
      `SELECT id, kind, exploit_id, category, reason
       FROM operator_requests
       WHERE status = 'queued' AND (requested_for IS NULL OR requested_for <= $1)${singleId === undefined ? '' : ' AND id = $2'}
       ORDER BY position NULLS LAST, created_at, id`,
      singleId === undefined ? [runDate] : [runDate, singleId],
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
   * The queue as the dry-run preview sees it: the same rows and order as
   * {@link drainOperatorRequests}, plus each request's cost estimate and, for a
   * rerun, its exploit's cell and OWASP ids. Read-only; statuses are untouched.
   */
  async previewOperatorRequests(runDate: string): Promise<QueuedRequest[]> {
    const result = await this.pool.query(
      `SELECT r.id, r.kind, r.exploit_id, COALESCE(r.category, e.category) AS category, e.subcategory,
              r.reason, r.estimated_cost_usd, e.owasp_ids
       FROM operator_requests r
       LEFT JOIN exploits e ON e.id = r.exploit_id
       WHERE r.status = 'queued' AND (r.requested_for IS NULL OR r.requested_for <= $1)
       ORDER BY r.position NULLS LAST, r.created_at, r.id`,
      [runDate],
    )
    return result.rows.map((r) => ({
      id: String(r.id),
      kind: r.kind,
      ...(r.exploit_id ? { exploit_id: String(r.exploit_id) } : {}),
      ...(r.category ? { category: String(r.category) } : {}),
      ...(r.subcategory ? { subcategory: String(r.subcategory) } : {}),
      ...(r.reason ? { reason: String(r.reason) } : {}),
      ...(r.estimated_cost_usd === null || r.estimated_cost_usd === undefined ? {} : { estimatedCostUsd: Number(r.estimated_cost_usd) }),
      ...(Array.isArray(r.owasp_ids) && r.owasp_ids.length > 0 ? { owaspIds: r.owasp_ids.map(String) } : {}),
    }))
  }

  /** The most recently seen target version, or a named one; null when none is recorded. */
  async findTargetVersion(version?: string): Promise<{ id: number; version: string } | null> {
    const result = await this.pool.query(
      `SELECT id, version FROM target_versions${version === undefined ? '' : ' WHERE version = $1'}
       ORDER BY first_seen DESC, id DESC LIMIT 1`,
      version === undefined ? [] : [version],
    )
    const row = result.rows[0]
    return row ? { id: Number(row.id), version: String(row.version) } : null
  }

  /**
   * The last run that actually ran (not a `scheduled` placeholder): when it
   * ended and which target version it tested, from its summary or plan.
   */
  async lastFinishedRun(): Promise<{ endedAt: string; targetVersion: string | null } | null> {
    const result = await this.pool.query(
      `SELECT COALESCE(finished_at, started_at, scheduled_for) AS ended_at,
              COALESCE(summary->>'target_version', plan->>'target_version') AS target_version
       FROM nightly_runs
       WHERE status IN ('completed', 'aborted', 'failed')
       ORDER BY COALESCE(finished_at, started_at, scheduled_for) DESC, id DESC LIMIT 1`,
    )
    const row = result.rows[0]
    if (!row) return null
    return {
      endedAt: new Date(row.ended_at as string | Date).toISOString(),
      targetVersion: row.target_version ? String(row.target_version) : null,
    }
  }

  /**
   * Regressions owed tonight (ARCHITECTURE 7.0 steps 2–3): the full suite of
   * stored exploits (all but false positives and accepted risks) when the
   * target version changed since the last run, and every ticket moved to
   * `fixed` since that run (all `fixed` tickets when there is no prior run).
   */
  async getOwedRegressions(args: { targetChanged: boolean; since: string | null }): Promise<RegressionOwed[]> {
    const owed: RegressionOwed[] = []
    const toOwed = (cause: RegressionOwed['cause']) => (r: Record<string, unknown>): RegressionOwed => ({
      exploitId: String(r.id),
      category: String(r.category),
      ...(r.subcategory ? { subcategory: String(r.subcategory) } : {}),
      cause,
      ...(Array.isArray(r.owasp_ids) && r.owasp_ids.length > 0 ? { owaspIds: r.owasp_ids.map(String) } : {}),
    })
    if (args.targetChanged) {
      const suite = await this.pool.query(
        `SELECT id, category, subcategory, owasp_ids FROM exploits
         WHERE status NOT IN ('false_positive', 'accepted_risk')
         ORDER BY created_at, id`,
      )
      owed.push(...suite.rows.map(toOwed('target_changed')))
    }
    const fixed = await this.pool.query(
      `SELECT id, category, subcategory, owasp_ids FROM exploits
       WHERE status = 'fixed'${args.since === null ? '' : ' AND updated_at > $1'}
       ORDER BY updated_at, id`,
      args.since === null ? [] : [args.since],
    )
    owed.push(...fixed.rows.map(toOwed('ticket_fixed')))
    return owed
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
