import type pg from 'pg'

import { listTaxonomyCells } from '@agentforge/contracts'

import { parseNightlyBudgetUsd } from './budget.js'
import type { QueuedRequest, RegressionOwed } from './planner.js'
import type { CoverageCellInput, Severity } from './priority.js'

/**
 * The planner's read side over Postgres: everything plan:preview needs to build
 * tonight's plan (queue, owed regressions, coverage matrix, operator budget,
 * standing plan). Read-only — it never drains operator_requests.
 */

type Queryable = Pick<pg.Pool, 'query'>

/** Attempts per cell considered "sufficient" coverage on a target version. */
const TARGET_ATTEMPTS = 10
/** A never-run cell is maximally stale so it is preferred by the priority score. */
const STALE_WHEN_NEVER_RUN = 30

export class PgPlanningRepository {
  constructor(private readonly pool: Queryable) {}

  /** The standing scheduled cron plan the dashboard reads (latest by scheduled_for DESC, id DESC). */
  async findStandingPlan(): Promise<{ nightlyRunId: number; targetVersion: string | null } | null> {
    const result = await this.pool.query(
      `SELECT id, plan->>'target_version' AS target_version FROM nightly_runs
       WHERE trigger = 'cron' AND status = 'scheduled'
       ORDER BY scheduled_for DESC, id DESC LIMIT 1`,
    )
    const row = result.rows[0]
    return row ? { nightlyRunId: Number(row.id), targetVersion: row.target_version ? String(row.target_version) : null } : null
  }

  async getNightlyBudgetUsd(): Promise<number | null> {
    // A database that predates the platform_settings migration reads as "no row".
    const present = await this.pool.query(`SELECT to_regclass('platform_settings') IS NOT NULL AS present`)
    if (present.rows[0]?.present !== true) return null
    const result = await this.pool.query('SELECT nightly_budget_usd FROM platform_settings WHERE id = 1')
    // Validated defensively (>$0, <=$1000, cents); an invalid value reads as "no row".
    return parseNightlyBudgetUsd(result.rows[0]?.nightly_budget_usd)
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
      familySize: Number(r.family_size ?? 1),
    })
    if (args.targetChanged) {
      const suite = await this.pool.query(
        `SELECT id, category, subcategory, owasp_ids, GREATEST(cardinality(family_ids), 1) AS family_size FROM exploits
         WHERE status NOT IN ('false_positive', 'accepted_risk')
         ORDER BY created_at, id`,
      )
      owed.push(...suite.rows.map(toOwed('target_changed')))
    }
    const fixed = await this.pool.query(
      `SELECT id, category, subcategory, owasp_ids, GREATEST(cardinality(family_ids), 1) AS family_size FROM exploits
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
