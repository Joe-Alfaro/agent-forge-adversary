import type pg from 'pg'

import type { ReportRecord } from '../../lib/approvals.js'
import type { QueueItem } from '../../lib/models.js'
import type { TicketRow } from '../../lib/tickets.js'

const TABLES = [
  'regression_results',
  'regression_runs',
  'coverage_snapshots',
  'agent_events',
  'chat_messages',
  'operator_requests',
  'reports',
  'verdicts',
  'exploits',
  'attempts',
  'campaigns',
  'nightly_runs',
  'target_versions',
  'targets',
]

/** Empties the platform tables and creates one target with the given versions. Returns version ids by name. */
export async function resetDatabase(pool: pg.Pool, versions: string[]): Promise<Map<string, number>> {
  await pool.query(`TRUNCATE ${TABLES.join(', ')} RESTART IDENTITY CASCADE`)
  const target = await pool.query<{ id: number }>(
    `INSERT INTO targets (base_url, kind, allowlisted_by) VALUES ('https://copilot.test', 'copilot', 'test') RETURNING id`,
  )
  const targetId = target.rows[0]?.id
  const ids = new Map<string, number>()
  await versions.reduce(async (previous, version, index) => {
    await previous
    const result = await pool.query<{ id: number }>(
      `INSERT INTO target_versions (target_id, version, first_seen) VALUES ($1, $2, $3) RETURNING id`,
      [targetId, version, new Date(Date.UTC(2026, 8, 1 + index))],
    )
    ids.set(version, result.rows[0]?.id ?? 0)
  }, Promise.resolve())
  return ids
}

export async function seedTickets(pool: pg.Pool, tickets: TicketRow[], versionIds: Map<string, number>): Promise<void> {
  await Promise.all(
    tickets.map((ticket) =>
      pool.query(
        `INSERT INTO exploits (id, fingerprint, severity, category, owasp_ids, status, assignee, min_repro, family_ids, discovered_version_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, '{}'::jsonb, ARRAY(SELECT gen_random_uuid() FROM generate_series(1, $8::int)), $9)`,
        [
          ticket.id,
          `fp-${ticket.id}`,
          ticket.severity,
          ticket.category,
          ticket.owaspIds,
          ticket.status,
          ticket.assignee ?? null,
          ticket.familySize,
          versionIds.get(ticket.discoveredVersion) ?? null,
        ],
      ),
    ),
  )
}

/** Inserts queue items with positions in array order. */
export async function seedQueue(pool: pg.Pool, items: QueueItem[], requestedFor: string): Promise<void> {
  await items.reduce(async (previous, item, index) => {
    await previous
    await pool.query(
      `INSERT INTO operator_requests (id, kind, exploit_id, category, requested_by, requested_for, source, created_at, position)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        item.id,
        item.kind,
        item.exploitId ?? null,
        item.category ?? null,
        item.requestedBy,
        requestedFor,
        item.source,
        item.requestedAt,
        index + 1,
      ],
    )
  }, Promise.resolve())
}

export async function seedReports(pool: pg.Pool, reports: ReportRecord[]): Promise<void> {
  await Promise.all(
    reports.map((report) =>
      pool.query(
        `INSERT INTO reports (id, exploit_id, version, body, status, approved_by, published_at, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          report.id,
          report.exploitId,
          report.version,
          { schema_version: '1', title: report.title },
          report.status,
          report.approvedBy ?? null,
          report.publishedAt ?? null,
          report.createdAt,
        ],
      ),
    ),
  )
}
