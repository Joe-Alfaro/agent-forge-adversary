import type pg from 'pg'

import { mergeCoverage, type TaxonomyCell } from '../lib/coverage.js'
import type { CostSummary, CoverageCell, RunSpend } from '../lib/models.js'
import { estimateRerunCostUsd, moveItem } from '../lib/queue.js'
import { nextRunDate } from '../lib/schedule.js'
import { isExploitStatus } from '../lib/tickets.js'
import type { QueueConfig } from './config.js'
import { mapMorningReport, mapQueueItem, mapRunSummary, mapTicket } from './pg-mappers.js'
import type { DashboardRepository } from './repository.js'
import { assertCanRecheck, assertRerunRequest, assertTransition, normalizeAssignee } from './rules.js'

export interface PgRepositoryOptions {
  pool: pg.Pool
  config: QueueConfig
  now?: () => Date
  /** Every cell the Coverage panel must show, tested or not. */
  taxonomy?: readonly TaxonomyCell[]
}

type Queryable = pg.Pool | pg.PoolClient

/*
 * Tickets are `exploits` rows. Confidence is the strongest successful verdict in
 * the exploit's family, and the last verdict comes from the family's most recent
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
    SELECT max(v.confidence) AS max_confidence
    FROM attempts a JOIN verdicts v ON v.attempt_id = a.id
    WHERE (a.id = ANY(e.family_ids) OR a.fingerprint = e.fingerprint) AND v.outcome = 'success'
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

/** Materialized cells for version $1, with OWASP ids from that version's attempts. */
const SNAPSHOT_SQL = `
  SELECT s.category, s.subcategory, s.attempts, s.confirmed, s.last_run_at,
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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const COST_RUN_WINDOW = 14
const COST_DAYS = 30

function sortedStrings(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }
  return value.filter((item): item is string => typeof item === 'string').sort()
}

export function createPgRepository({
  pool,
  config,
  now = () => new Date(),
  taxonomy = [],
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

  async function readQueue(db: Queryable) {
    const runDate = nextRunDate(now(), config)
    const result = await db.query(queueSql(false), [runDate])
    return { runDate, envelopeUsd: config.envelopeUsd, items: result.rows.map(mapQueueItem) }
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
        `${RUNS_SQL} ORDER BY COALESCE(r.started_at, r.scheduled_for) DESC, r.id DESC LIMIT 60`,
        [now()],
      )
      return result.rows.map(mapRunSummary)
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
        return { targetVersion: 'no target version yet', cells: mergeCoverage([], taxonomy) }
      }
      const snapshot = await pool.query(SNAPSHOT_SQL, [version.id])
      const result = snapshot.rowCount ? snapshot : await pool.query(COVERAGE_SQL, [version.id])
      const cells = result.rows.map((row): CoverageCell => {
        const cell: CoverageCell = {
          category: String(row.category),
          subcategory: row.subcategory === '' ? 'unspecified' : String(row.subcategory),
          owaspIds: sortedStrings(row.owasp_ids),
          attempts: Number(row.attempts),
          confirmed: Number(row.confirmed),
        }
        return row.last_run_at instanceof Date ? { ...cell, lastRunAt: row.last_run_at.toISOString() } : cell
      })
      return { targetVersion: String(version.version), cells: mergeCoverage(cells, taxonomy) }
    },

    async getCost(): Promise<CostSummary> {
      const runs = await pool.query(
        `SELECT id, COALESCE(started_at, scheduled_for) AS started_at, spend_usd, status
         FROM nightly_runs ORDER BY COALESCE(started_at, scheduled_for) DESC, id DESC LIMIT $1`,
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
  }
}
