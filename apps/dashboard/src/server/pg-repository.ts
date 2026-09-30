import type pg from 'pg'

import { listTaxonomyCells, PRD_CATEGORIES, type TaxonomyCell } from '@agentforge/contracts'

import { isReportStatus, sortApprovals } from '../lib/approvals.js'
import { isVerdictOutcome, resolvedOutcome } from '../lib/judge.js'
import { buildRunNowPlan } from '../lib/run-now.js'
import { parseTonightPlan } from '../lib/tonight.js'
import { parseNightlyBudget } from '../lib/budget.js'
import { cellKey, mergeCoverage } from '../lib/coverage.js'
import type { CostSummary, CoverageCell, RunSpend } from '../lib/models.js'
import { estimateRerunCostUsd, moveItem } from '../lib/queue.js'
import { nextRunDate } from '../lib/schedule.js'
import { isExploitStatus } from '../lib/tickets.js'
import { isRunNowEnabled, m5Options, type QueueConfig } from './config.js'
import { computeM5 } from './m5.js'
import {
  mapAgentEvent,
  mapApprovalRow,
  mapCoverageRow,
  mapMorningReport,
  mapQueueItem,
  mapReviewItem,
  mapRunSummary,
  mapTicket,
  stringArray,
} from './pg-mappers.js'
import type { DashboardRepository } from './repository.js'
import {
  assertCanRecheck,
  assertReportDecision,
  assertRunNow,
  assertRunNowEnabled,
  assertRerunRequest,
  assertTransition,
  normalizeAssignee,
} from './rules.js'

export interface PgRepositoryOptions {
  pool: pg.Pool
  config: QueueConfig
  now?: () => Date
  /** Every cell the Coverage panel must show, tested or not (defaults to AttackTaxonomy v1). */
  taxonomy?: readonly TaxonomyCell[]
}

type Queryable = pg.Pool | pg.PoolClient

/*
 * Tickets are `exploits` rows. Confidence is the strongest success among the
 * latest verdicts of the exploit's family (a human verdict supersedes the Judge's), and the last verdict comes from the family's most recent
 * verdict (family = family_ids plus the fingerprint). The last verified version
 * is the newest regression result's target version, or failing that the
 * version of the latest verdict.
 */
const TICKETS_SQL = `
  SELECT e.id, e.severity, e.category, e.owasp_ids, e.status, e.assignee,
         GREATEST(cardinality(e.family_ids), 1) AS family_size,
         dv.version AS discovered_version,
         conf.max_confidence,
         latest.outcome AS last_verdict,
         COALESCE(regression.version, latest.version) AS last_verified_version
  FROM exploits e
  LEFT JOIN target_versions dv ON dv.id = e.discovered_version_id
  LEFT JOIN LATERAL (
    -- Each attempt's latest verdict only, so a Judge success a human overturned no longer counts.
    SELECT max(lv.confidence) AS max_confidence
    FROM attempts a
    JOIN LATERAL (
      SELECT v.outcome, v.confidence FROM verdicts v WHERE v.attempt_id = a.id ORDER BY v.created_at DESC, v.id LIMIT 1
    ) lv ON true
    WHERE (a.id = ANY(e.family_ids) OR a.fingerprint = e.fingerprint) AND lv.outcome = 'success'
  ) conf ON true
  LEFT JOIN LATERAL (
    SELECT v.outcome, tv.version
    FROM attempts a
    JOIN verdicts v ON v.attempt_id = a.id
    LEFT JOIN target_versions tv ON tv.id = a.target_version_id
    WHERE a.id = ANY(e.family_ids) OR a.fingerprint = e.fingerprint
    ORDER BY v.created_at DESC
    LIMIT 1
  ) latest ON true
  LEFT JOIN LATERAL (
    SELECT tv.version
    FROM regression_results rr
    JOIN regression_runs rrun ON rrun.id = rr.run_id
    JOIN target_versions tv ON tv.id = rrun.target_version_id
    WHERE rr.exploit_id = e.id
    ORDER BY rr.created_at DESC
    LIMIT 1
  ) regression ON true`

/** $1 is "now", used to window new tickets for runs without a summary. */
const RUNS_SQL = `
  SELECT r.id, r.trigger, r.status, COALESCE(r.started_at, r.scheduled_for) AS started_at,
         r.finished_at, r.spend_usd, r.summary,
         stats.attempts, stats.success, stats.partial, stats.fail, stats.target_version,
         (SELECT count(*) FROM exploits e
          WHERE r.started_at IS NOT NULL
            AND e.created_at >= r.started_at
            AND e.created_at < COALESCE(r.finished_at, $1)) AS new_tickets_by_time
  FROM nightly_runs r
  LEFT JOIN LATERAL (
    SELECT count(*) AS attempts,
           count(*) FILTER (WHERE lv.outcome = 'success') AS success,
           count(*) FILTER (WHERE lv.outcome = 'partial') AS partial,
           count(*) FILTER (WHERE lv.outcome = 'fail') AS fail,
           mode() WITHIN GROUP (ORDER BY tv.version) AS target_version
    FROM campaigns c
    JOIN attempts a ON a.campaign_id = c.id
    LEFT JOIN target_versions tv ON tv.id = a.target_version_id
    LEFT JOIN LATERAL (
      SELECT v.outcome FROM verdicts v WHERE v.attempt_id = a.id ORDER BY v.created_at DESC LIMIT 1
    ) lv ON true
    WHERE c.nightly_run_id = r.id
  ) stats ON true`

/** Live coverage for version $1, used until the Orchestrator writes coverage_snapshots. */
const COVERAGE_SQL = `
  WITH cells AS (
    SELECT a.category, COALESCE(a.subcategory, '') AS subcategory,
           count(DISTINCT a.id) AS attempts,
           max(a.created_at) AS last_run_at,
           COALESCE(array_agg(DISTINCT o.owasp) FILTER (WHERE o.owasp IS NOT NULL), '{}') AS owasp_ids
    FROM attempts a
    LEFT JOIN LATERAL unnest(a.owasp_ids) AS o(owasp) ON true
    WHERE a.target_version_id = $1
    GROUP BY a.category, COALESCE(a.subcategory, '')
  ), confirmed AS (
    SELECT category, COALESCE(subcategory, '') AS subcategory, count(*) AS confirmed
    FROM exploits
    WHERE status <> 'false_positive'
    GROUP BY category, COALESCE(subcategory, '')
  )
  SELECT cells.*, COALESCE(confirmed.confirmed, 0) AS confirmed
  FROM cells
  LEFT JOIN confirmed USING (category, subcategory)
  ORDER BY cells.category, cells.subcategory`

/**
 * Variant families per cell on version $1: distinct lineage roots (following
 * parent_attempt_id) among the cell's variant attempts.
 */
const FAMILIES_SQL = `
  WITH RECURSIVE lineage AS (
    SELECT id, id AS root FROM attempts WHERE parent_attempt_id IS NULL
    UNION ALL
    SELECT a.id, l.root FROM attempts a JOIN lineage l ON a.parent_attempt_id = l.id
  )
  SELECT a.category, COALESCE(a.subcategory, '') AS subcategory,
         count(DISTINCT l.root) FILTER (WHERE a.parent_attempt_id IS NOT NULL) AS families_exercised
  FROM attempts a
  JOIN lineage l ON l.id = a.id
  WHERE a.target_version_id = $1
  GROUP BY a.category, COALESCE(a.subcategory, '')`

/** Materialized cells for version $1, with OWASP ids from that version's attempts. */
function snapshotSql(hasFamiliesColumn: boolean): string {
  return `
  SELECT s.category, s.subcategory, s.attempts, s.confirmed, s.last_run_at,
         ${hasFamiliesColumn ? 's.families_exercised' : 'NULL::integer AS families_exercised'},
         COALESCE((
           SELECT array_agg(DISTINCT o.owasp)
           FROM attempts a, unnest(a.owasp_ids) AS o(owasp)
           WHERE a.target_version_id = s.target_version_id
             AND a.category = s.category
             AND COALESCE(a.subcategory, '') = s.subcategory
         ), '{}') AS owasp_ids
  FROM coverage_snapshots s
  WHERE s.target_version_id = $1
  ORDER BY s.category, s.subcategory`
}

/** Queued requests up to tonight in drain order; $1 is tonight's run date. */
function queueSql(lock: boolean): string {
  return `
    SELECT r.id, r.kind, r.exploit_id, r.category, r.requested_by, r.source, r.reason, r.created_at,
           r.estimated_cost_usd,
           CASE WHEN e.id IS NULL THEN NULL ELSE GREATEST(cardinality(e.family_ids), 1) END AS family_size
    FROM operator_requests r
    LEFT JOIN exploits e ON e.id = r.exploit_id
    WHERE r.status = 'queued' AND (r.requested_for IS NULL OR r.requested_for <= $1)
    ORDER BY r.position NULLS LAST, r.created_at, r.id
    ${lock ? 'FOR UPDATE OF r' : ''}`
}

/** A human verdict on the same attempt, at or after the flagged one, settles it. */
const UNRESOLVED = `
  v.needs_review AND v.stage <> 'human'
  AND NOT EXISTS (
    SELECT 1 FROM verdicts h
    WHERE h.attempt_id = v.attempt_id AND h.stage = 'human' AND h.created_at >= v.created_at
  )`

const REVIEW_COLUMNS = `
  SELECT v.id, v.attempt_id, v.outcome, v.confidence, v.stage, v.rubric_version, v.judge_model, v.evidence,
         v.created_at, a.category, a.subcategory, a.transcript, tv.version AS target_version,
         (SELECT e.id FROM exploits e
          WHERE a.id = ANY(e.family_ids) OR a.fingerprint = e.fingerprint
          ORDER BY e.created_at, e.id LIMIT 1) AS exploit_id
  FROM verdicts v
  JOIN attempts a ON a.id = v.attempt_id
  LEFT JOIN target_versions tv ON tv.id = a.target_version_id`

/**
 * Settled reviews per category: each human verdict against the flagged Judge
 * verdict it answered (the latest flagged one on that attempt before it).
 */
const REVIEWED_SQL = `
  SELECT a.category, count(*) AS reviewed, count(*) FILTER (WHERE f.outcome <> h.outcome) AS overturned
  FROM verdicts h
  JOIN attempts a ON a.id = h.attempt_id
  JOIN LATERAL (
    SELECT f.outcome FROM verdicts f
    WHERE f.attempt_id = h.attempt_id AND f.needs_review AND f.stage <> 'human' AND f.created_at <= h.created_at
    ORDER BY f.created_at DESC
    LIMIT 1
  ) f ON true
  WHERE h.stage = 'human'
  GROUP BY a.category
  ORDER BY a.category`

/**
 * M4 inputs. An attempt is novel when it is the first with its fingerprint (the
 * Red Team's novelty check). Each is counted under its latest verdict's rubric;
 * it is confirmed when that verdict is a success no longer awaiting review, so a
 * human verdict (Section 8.4) settles a needs_review success either way.
 * Unjudged attempts are left out.
 */
const RESILIENCE_SQL = `
  WITH novel AS (
    SELECT DISTINCT ON (fingerprint) id, target_version_id
    FROM attempts
    ORDER BY fingerprint, created_at, id
  ), latest AS (
    SELECT DISTINCT ON (attempt_id) attempt_id, outcome, rubric_version, needs_review, created_at
    FROM verdicts
    ORDER BY attempt_id, created_at DESC, id
  )
  SELECT tv.version, latest.rubric_version,
         count(*) AS novel_attempts,
         count(*) FILTER (WHERE latest.outcome = 'success' AND NOT latest.needs_review) AS confirmed
  FROM novel
  JOIN target_versions tv ON tv.id = novel.target_version_id
  JOIN latest ON latest.attempt_id = novel.id
  GROUP BY tv.id, tv.version, tv.first_seen, latest.rubric_version
  -- Within a version, the older rubric first, so series keep the order rubrics were introduced.
  ORDER BY tv.first_seen, tv.id, min(latest.created_at), latest.rubric_version`

/** Report rows with the fields the approvals queue shows. */
const REPORTS_SQL = `
  SELECT r.id, r.exploit_id, r.version, r.status, r.approved_by, r.published_at, r.created_at,
         r.body->>'title' AS title, e.severity, e.category
  FROM reports r
  JOIN exploits e ON e.id = r.exploit_id`

/** A superseded draft is not offered: only the newest version per exploit waits for approval. */
const PENDING_APPROVALS_SQL = `${REPORTS_SQL}
  WHERE r.status = 'draft'
    AND NOT EXISTS (SELECT 1 FROM reports newer WHERE newer.exploit_id = r.exploit_id AND newer.version > r.version)`

/** Tonight's plan preview: the newest cron run that has not started (Section 7.0). */
const SCHEDULED_PLAN_SQL = `
  SELECT id, scheduled_for, plan FROM nightly_runs
  WHERE trigger = 'cron' AND status = 'scheduled' AND plan IS NOT NULL
  ORDER BY scheduled_for DESC, id DESC
  LIMIT 1`

/** OWASP ids seen per cell in attempts, for plan items that do not carry their own. */
const CELL_OWASP_SQL = `
  SELECT a.category, COALESCE(a.subcategory, '') AS subcategory, array_agg(DISTINCT o.owasp ORDER BY o.owasp) AS owasp_ids
  FROM attempts a, unnest(a.owasp_ids) AS o(owasp)
  GROUP BY a.category, COALESCE(a.subcategory, '')`

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const COST_RUN_WINDOW = 14
const COST_DAYS = 30

export function createPgRepository({
  pool,
  config,
  now = () => new Date(),
  taxonomy = listTaxonomyCells(),
}: PgRepositoryOptions): DashboardRepository {
  async function transaction<T>(work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const result = await work(client)
      await client.query('COMMIT')
      return result
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  /** The newest scheduled cron run's NightlyPlan (plan:preview), with OWASP ids per cell from attempts as a fallback. */
  async function readTonightPlan(db: Queryable) {
    const scheduled = await db.query(SCHEDULED_PLAN_SQL)
    const [row] = scheduled.rows
    if (!row) {
      return null
    }
    const owasp = await db.query(CELL_OWASP_SQL)
    const byCell = new Map(owasp.rows.map((cell) => [`${String(cell.category)}/${String(cell.subcategory)}`, stringArray(cell.owasp_ids)]))
    const plan = parseTonightPlan(
      { runId: String(row.id), scheduledFor: new Date(row.scheduled_for).toISOString(), plan: row.plan },
      (category, subcategory) => byCell.get(`${category}/${subcategory ?? ''}`) ?? [],
    )
    if (!plan) {
      console.warn(`nightly_runs ${String(row.id)}: scheduled plan is not a NightlyPlan; the queue shows operator requests only`)
    }
    return plan
  }

  async function hasPlatformSettings(db: Queryable): Promise<boolean> {
    const result = await db.query(`SELECT to_regclass('platform_settings') IS NOT NULL AS present`)
    return result.rows[0]?.present === true
  }

  /** The operator's in-app budget (platform_settings row 1), or NIGHTLY_BUDGET_USD until that table exists. */
  async function readBudget(db: Queryable): Promise<number> {
    if (!(await hasPlatformSettings(db))) {
      return config.envelopeUsd
    }
    const result = await db.query('SELECT nightly_budget_usd FROM platform_settings WHERE id = 1')
    const [row] = result.rows
    return row ? Number(row.nightly_budget_usd) : config.envelopeUsd
  }

  async function readQueue(db: Queryable) {
    const runDate = nextRunDate(now(), config)
    const result = await db.query(queueSql(false), [runDate])
    return {
      runDate,
      envelopeUsd: await readBudget(db),
      items: result.rows.map(mapQueueItem),
      runNowEnabled: isRunNowEnabled(config),
      plan: await readTonightPlan(db),
    }
  }

  async function getRun(runId: string) {
    if (!/^\d+$/.test(runId)) {
      return null
    }
    const result = await pool.query(`${RUNS_SQL} WHERE r.id = $2`, [now(), Number(runId)])
    const [row] = result.rows
    return row ? mapRunSummary(row) : null
  }

  async function getTicket(id: string) {
    const result = await pool.query(`${TICKETS_SQL} WHERE e.id = $1`, [id])
    const [row] = result.rows
    return row ? mapTicket(row) : null
  }

  return {
    async listTickets() {
      const result = await pool.query(TICKETS_SQL)
      return result.rows.map(mapTicket)
    },

    getTicket,

    async updateTicket(id, update) {
      await transaction(async (client) => {
        const current = await client.query('SELECT status FROM exploits WHERE id = $1 FOR UPDATE', [id])
        const status: unknown = current.rows[0]?.status
        if (!isExploitStatus(status)) {
          throw new Error(`Unknown ticket ${id}`)
        }
        assertTransition(status, update.status)
        await client.query('UPDATE exploits SET status = $2, assignee = $3, updated_at = now() WHERE id = $1', [
          id,
          update.status,
          normalizeAssignee(update.assignee) ?? null,
        ])
      })
      const ticket = await getTicket(id)
      if (!ticket) {
        throw new Error(`Unknown ticket ${id}`)
      }
      return ticket
    },

    async listRuns() {
      const result = await pool.query(
        // Only started runs: a scheduled cron run is tonight's plan preview (the queue page shows it),
        // and a scheduled run-now is followed by id until it starts.
        `${RUNS_SQL} WHERE r.status <> 'scheduled'
         ORDER BY COALESCE(r.started_at, r.scheduled_for) DESC, r.id DESC LIMIT 60`,
        [now()],
      )
      return result.rows.map(mapRunSummary)
    },

    getRun,

    async runNow(scope, requestedBy) {
      assertRunNowEnabled(isRunNowEnabled(config))
      const runId = await transaction(async (client) => {
        // Serializes concurrent confirms, so two clicks cannot schedule two runs.
        await client.query(`SELECT pg_advisory_xact_lock(hashtext('agentforge:run_now'))`)
        const active = await client.query(
          `SELECT 1 FROM nightly_runs WHERE trigger = 'run_now' AND status IN ('scheduled', 'running') LIMIT 1`,
        )
        const queue = await readQueue(client)
        assertRunNow(queue.items, scope, (active.rowCount ?? 0) > 0)
        const requestedAt = now()
        const inserted = await client.query(
          `INSERT INTO nightly_runs (scheduled_for, trigger, status, plan)
           VALUES ($1, 'run_now', 'scheduled', $2) RETURNING id`,
          [requestedAt, buildRunNowPlan(scope, requestedBy, requestedAt)],
        )
        return String(inserted.rows[0]?.id)
      })
      const run = await getRun(runId)
      if (!run) {
        throw new Error(`Run ${runId} was not written`)
      }
      return run
    },

    async getMorningReport(runId) {
      if (!/^\d+$/.test(runId)) {
        return null
      }
      const result = await pool.query(`${RUNS_SQL} WHERE r.id = $2`, [now(), Number(runId)])
      const [row] = result.rows
      return row ? mapMorningReport(row) : null
    },

    async getCoverage() {
      const latest = await pool.query('SELECT id, version FROM target_versions ORDER BY first_seen DESC, id DESC LIMIT 1')
      const version = latest.rows[0]
      if (!version) {
        const empty = mergeCoverage([], taxonomy)
        return {
          targetVersion: 'no target version yet',
          cells: empty,
          m5: computeM5(empty, m5Options(config, now())),
          prdCategories: [...PRD_CATEGORIES],
        }
      }
      // Use coverage_snapshots.families_exercised as soon as the column exists; count live until then.
      const familiesColumn = await pool.query(
        `SELECT 1 FROM information_schema.columns
         WHERE table_schema = current_schema() AND table_name = 'coverage_snapshots' AND column_name = 'families_exercised'`,
      )
      const snapshot = await pool.query(snapshotSql((familiesColumn.rowCount ?? 0) > 0), [version.id])
      const result = snapshot.rowCount ? snapshot : await pool.query(COVERAGE_SQL, [version.id])
      const liveFamilies = await pool.query(FAMILIES_SQL, [version.id])
      const familiesByKey = new Map(
        liveFamilies.rows.map((row) => [cellKey({ category: String(row.category), subcategory: String(row.subcategory) }), Number(row.families_exercised)]),
      )
      const mapped = result.rows.map(mapCoverageRow)
      const cells = mapped
        .filter((cell): cell is CoverageCell => cell !== null)
        .map((cell) => ({ ...cell, familiesExercised: cell.familiesExercised ?? familiesByKey.get(cellKey(cell)) ?? 0 }))
      if (cells.length < mapped.length) {
        console.warn(`coverage: ignored ${mapped.length - cells.length} cell(s) outside AttackTaxonomy v1`)
      }
      const merged = mergeCoverage(cells, taxonomy)
      return {
        targetVersion: String(version.version),
        cells: merged,
        m5: computeM5(merged, m5Options(config, now())),
        prdCategories: [...PRD_CATEGORIES],
      }
    },

    async getCost(): Promise<CostSummary> {
      const runs = await pool.query(
        `SELECT id, COALESCE(started_at, scheduled_for) AS started_at, spend_usd, status
         FROM nightly_runs WHERE status <> 'scheduled' ORDER BY COALESCE(started_at, scheduled_for) DESC, id DESC LIMIT $1`,
        [COST_RUN_WINDOW],
      )
      const roles = await pool.query(
        `SELECT agent, sum(cost_usd) AS spend
         FROM agent_events
         WHERE created_at > $1::timestamptz - make_interval(days => $2) AND created_at <= $1
         GROUP BY agent ORDER BY sum(cost_usd) DESC, agent`,
        [now(), COST_DAYS],
      )
      const byRun = runs.rows.map(
        (row): RunSpend => ({
          runId: String(row.id),
          startedAt: new Date(row.started_at).toISOString(),
          spendUsd: Number(row.spend_usd),
        }),
      )
      const byRole = roles.rows.map((row) => ({ role: String(row.agent), spendUsd: Number(row.spend) }))
      const completed = runs.rows.filter((row) => row.status === 'completed').map((row) => Number(row.spend_usd))
      const averageNight = completed.length === 0 ? 0 : completed.reduce((sum, spend) => sum + spend, 0) / completed.length
      return {
        periodLabel: `Last ${COST_DAYS} days`,
        totalUsd: Math.round(byRole.reduce((sum, entry) => sum + entry.spendUsd, 0) * 100) / 100,
        byRole,
        byRun,
        // One run a night at the current average.
        projectedMonthlyUsd: Math.round(averageNight * 30 * 100) / 100,
      }
    },

    async getQueue() {
      return readQueue(pool)
    },

    async enqueueRerun(input) {
      const { request, exploitId } = assertRerunRequest(input)
      await transaction(async (client) => {
        // Locking the exploit serializes concurrent re-checks of the same ticket.
        const ticket = await client.query(
          'SELECT status, GREATEST(cardinality(family_ids), 1) AS family_size FROM exploits WHERE id = $1 FOR UPDATE',
          [exploitId],
        )
        const status: unknown = ticket.rows[0]?.status
        if (!isExploitStatus(status)) {
          throw new Error(`Unknown ticket ${exploitId}`)
        }
        const queued = await client.query(
          `SELECT 1 FROM operator_requests WHERE kind = 'rerun' AND exploit_id = $1 AND status = 'queued'`,
          [exploitId],
        )
        assertCanRecheck(exploitId, status, (queued.rowCount ?? 0) > 0)
        await client.query(
          `INSERT INTO operator_requests
             (id, kind, exploit_id, requested_by, requested_for, source, reason, created_at, estimated_cost_usd, position)
           VALUES ($1, 'rerun', $2, $3, $4, $5, $6, $7, $8,
                   (SELECT COALESCE(max(position), 0) + 1 FROM operator_requests WHERE status = 'queued'))`,
          [
            request.message_id,
            exploitId,
            request.requested_by,
            request.requested_for,
            request.source,
            request.reason ?? null,
            now(),
            estimateRerunCostUsd(Number(ticket.rows[0]?.family_size)),
          ],
        )
      })
      return readQueue(pool)
    },

    async updateNightlyBudget(value) {
      const budgetUsd = parseNightlyBudget(value)
      if (!(await hasPlatformSettings(pool))) {
        throw new Error(
          'The platform_settings table is not migrated yet, so the budget comes from NIGHTLY_BUDGET_USD and cannot be changed here',
        )
      }
      await pool.query(
        `INSERT INTO platform_settings (id, nightly_budget_usd, updated_at) VALUES (1, $1, now())
         ON CONFLICT (id) DO UPDATE SET nightly_budget_usd = EXCLUDED.nightly_budget_usd, updated_at = now()`,
        [budgetUsd],
      )
      return readQueue(pool)
    },

    async removeQueueItem(id) {
      if (UUID.test(id)) {
        await pool.query(`UPDATE operator_requests SET status = 'cancelled' WHERE id = $1 AND status = 'queued'`, [id])
      }
      return readQueue(pool)
    },

    async moveQueueItem(id, direction) {
      await transaction(async (client) => {
        const runDate = nextRunDate(now(), config)
        const current = await client.query(queueSql(true), [runDate])
        const ids = current.rows.map((row) => ({ id: String(row.id) }))
        const reordered = moveItem(ids, id, direction)
        // Renumbering the whole queue also gives chat-inserted rows (NULL position) a place.
        await client.query(
          `UPDATE operator_requests AS r SET position = o.position
           FROM unnest($1::uuid[]) WITH ORDINALITY AS o(id, position)
           WHERE r.id = o.id`,
          [reordered.map((item) => item.id)],
        )
      })
      return readQueue(pool)
    },

    async listAgentEvents(limit) {
      const result = await pool.query(
        `SELECT id, trace_id, agent, event_type, payload, source, cost_usd, created_at
         FROM agent_events
         ORDER BY created_at DESC, id DESC
         LIMIT $1`,
        [limit],
      )
      return result.rows.map(mapAgentEvent)
    },

    async listNeedsReview() {
      const result = await pool.query(`${REVIEW_COLUMNS} WHERE ${UNRESOLVED} ORDER BY v.created_at, v.id`)
      return result.rows.map(mapReviewItem)
    },

    async resolveReview(verdictId, input, reviewer) {
      if (!UUID.test(verdictId)) {
        throw new Error(`Unknown verdict ${verdictId}`)
      }
      const resolvedAt = now()
      const outcome = await transaction(async (client) => {
        // Locking the flagged verdict serializes two reviewers resolving it at once.
        const flagged = await client.query(
          `SELECT v.outcome, v.rubric_version, v.evidence, v.created_at, v.attempt_id, a.category, a.transcript
           FROM verdicts v JOIN attempts a ON a.id = v.attempt_id
           WHERE v.id = $1 AND v.needs_review AND v.stage <> 'human'
           FOR UPDATE OF v`,
          [verdictId],
        )
        const row = flagged.rows[0]
        if (!row) {
          throw new Error(`Unknown verdict ${verdictId}`)
        }
        const pending = await client.query(`SELECT 1 FROM verdicts v WHERE v.id = $1 AND ${UNRESOLVED}`, [verdictId])
        if (!pending.rowCount) {
          throw new Error(`Verdict ${verdictId} is already resolved`)
        }
        const judged: unknown = row.outcome
        if (!isVerdictOutcome(judged)) {
          throw new Error(`Verdict ${verdictId} has an unknown outcome "${String(judged)}"`)
        }
        const decided = resolvedOutcome(judged, input)
        await client.query(
          `INSERT INTO verdicts (attempt_id, outcome, confidence, stage, rubric_version, judge_model, evidence, needs_review, created_at)
           VALUES ($1, $2, 1, 'human', $3, NULL, $4, false, $5)`,
          [row.attempt_id, decided, row.rubric_version, JSON.stringify(row.evidence ?? []), resolvedAt],
        )
        await client.query(
          `INSERT INTO ground_truth (transcript, label, category, labeled_by, labeled_at) VALUES ($1, $2, $3, $4, $5)`,
          [row.transcript, decided, row.category, reviewer, resolvedAt],
        )
        return decided
      })
      return { verdictId, decision: input.decision, outcome, reviewer, resolvedAt: resolvedAt.toISOString() }
    },

    async getJudgeHealth() {
      const backlog = await pool.query(`SELECT count(*) AS backlog, min(v.created_at) AS oldest FROM verdicts v WHERE ${UNRESOLVED}`)
      const reviewed = await pool.query(REVIEWED_SQL)
      const truth = await pool.query('SELECT count(*) AS labels FROM ground_truth')
      const byCategory = reviewed.rows.map((row) => ({
        category: String(row.category),
        reviewed: Number(row.reviewed),
        overturned: Number(row.overturned),
      }))
      const oldest: unknown = backlog.rows[0]?.oldest
      const health = {
        backlog: Number(backlog.rows[0]?.backlog ?? 0),
        reviewed: byCategory.reduce((sum, entry) => sum + entry.reviewed, 0),
        overturned: byCategory.reduce((sum, entry) => sum + entry.overturned, 0),
        byCategory,
        groundTruthLabels: Number(truth.rows[0]?.labels ?? 0),
      }
      return oldest instanceof Date ? { ...health, oldestPendingAt: oldest.toISOString() } : health
    },

    async getResilienceTrend() {
      const versions = await pool.query('SELECT version FROM target_versions ORDER BY first_seen, id')
      const points = await pool.query(RESILIENCE_SQL)
      return {
        versions: versions.rows.map((row) => String(row.version)),
        points: points.rows.map((row) => ({
          targetVersion: String(row.version),
          rubricVersion: String(row.rubric_version),
          novelAttempts: Number(row.novel_attempts),
          confirmed: Number(row.confirmed),
        })),
      }
    },

    async listApprovals() {
      const result = await pool.query(PENDING_APPROVALS_SQL)
      return sortApprovals(result.rows.map(mapApprovalRow))
    },

    async decideApproval(reportId, decision, reviewer) {
      if (!UUID.test(reportId)) {
        throw new Error(`Unknown report ${reportId}`)
      }
      await transaction(async (client) => {
        const current = await client.query('SELECT status FROM reports WHERE id = $1 FOR UPDATE', [reportId])
        const status: unknown = current.rows[0]?.status
        if (!isReportStatus(status)) {
          throw new Error(`Unknown report ${reportId}`)
        }
        const next = assertReportDecision(status, decision)
        await client.query(
          `UPDATE reports SET status = $2, approved_by = $3,
                  published_at = CASE WHEN $2 = 'published' THEN $4::timestamptz ELSE published_at END
           WHERE id = $1`,
          [reportId, next, reviewer, now()],
        )
      })
      const result = await pool.query(`${REPORTS_SQL} WHERE r.id = $1`, [reportId])
      return mapApprovalRow(result.rows[0])
    },
  }
}
