import type pg from 'pg'

import type { AttackTranscript, Evidence, VulnReportStatus, VulnSeverity } from '@agentforge/contracts'

import type { ConfirmedExploit, DocsEventRow, DocsRepository, Rediscovery, ReportRow } from './types.js'

const SEVERITIES: readonly string[] = ['critical', 'high', 'medium', 'low']
const REPORT_STATUSES: readonly string[] = ['draft', 'published', 'rejected', 'false_positive']

/**
 * Confirmed exploits with no report yet, joined to the confirming attempt named
 * in min_repro (transcript + newest verdict evidence). False positives are never
 * documented. The attempt id is compared as text because min_repro is free-form.
 */
const UNREPORTED_SQL = `
  SELECT e.id, e.fingerprint, e.severity, e.category, e.subcategory, e.owasp_ids, e.min_repro, e.created_at,
         tv.version AS target_version, a.transcript, v.evidence
  FROM exploits e
  LEFT JOIN target_versions tv ON tv.id = e.discovered_version_id
  LEFT JOIN attempts a ON a.id::text = e.min_repro->>'attempt_id'
  LEFT JOIN LATERAL (
    SELECT evidence FROM verdicts WHERE attempt_id = a.id ORDER BY created_at DESC LIMIT 1
  ) v ON true
  WHERE e.status <> 'false_positive'
    AND NOT EXISTS (SELECT 1 FROM reports r WHERE r.exploit_id = e.id)
  ORDER BY e.created_at, e.id`

/**
 * For each exploit's newest report, the newest confirmed hit on the same
 * fingerprint that landed after that report was written. Writing the next
 * version moves the watermark, so a pass never re-applies the same hit.
 */
const REDISCOVERIES_SQL = `
  WITH latest AS (
    SELECT DISTINCT ON (r.exploit_id) r.exploit_id, r.version, r.status, r.body, r.created_at
    FROM reports r
    ORDER BY r.exploit_id, r.version DESC
  )
  SELECT l.exploit_id, l.version, l.status, l.body, hit.id AS attempt_id, hit.created_at AS hit_at,
         tv.version AS target_version
  FROM latest l
  JOIN exploits e ON e.id = l.exploit_id AND e.status <> 'false_positive'
  JOIN LATERAL (
    SELECT a.id, a.created_at, a.target_version_id
    FROM attempts a
    JOIN verdicts vd ON vd.attempt_id = a.id AND vd.outcome = 'success' AND NOT vd.needs_review
    WHERE a.fingerprint = e.fingerprint AND a.created_at > l.created_at
    ORDER BY a.created_at DESC
    LIMIT 1
  ) hit ON true
  LEFT JOIN target_versions tv ON tv.id = hit.target_version_id
  ORDER BY l.exploit_id`

type Row = Record<string, unknown>

function iso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString()
}

function lastResponse(transcript: AttackTranscript | null): string | undefined {
  const last = transcript?.turns.at(-1)?.target_response
  if (last === undefined || last === null) {
    return undefined
  }
  if (typeof last === 'string') {
    return last
  }
  // The Co-Pilot answers with claims plus telemetry; the claims are what the clinician saw.
  const claims = (last as { claims?: unknown }).claims
  if (Array.isArray(claims)) {
    const texts = claims
      .map((claim) => (claim as { text?: unknown }).text)
      .filter((text): text is string => typeof text === 'string')
    if (texts.length > 0) {
      return texts.join(' ')
    }
  }
  return JSON.stringify(last)
}

function mapExploit(row: Row): ConfirmedExploit {
  const id = String(row.id)
  const severity = String(row.severity)
  if (!SEVERITIES.includes(severity)) {
    throw new Error(`Exploit ${id} has an unknown severity "${severity}"`)
  }
  const repro = (row.min_repro ?? {}) as { turns?: unknown; attempt_id?: unknown }
  const turns = Array.isArray(repro.turns) ? repro.turns.map(String) : []
  const attemptId = typeof repro.attempt_id === 'string' ? repro.attempt_id : undefined
  const transcript = (row.transcript ?? null) as AttackTranscript | null
  const observedResponse = lastResponse(transcript)
  const optional = {
    ...(transcript?.session.role ? { sessionRole: transcript.session.role } : {}),
    ...(transcript?.session.context_patient_id !== undefined ? { contextPatientId: transcript.session.context_patient_id } : {}),
    ...(transcript?.trace_id ? { traceId: transcript.trace_id } : {}),
    ...(Array.isArray(row.evidence) ? { evidence: row.evidence as Evidence[] } : {}),
    ...(observedResponse ? { observedResponse } : {}),
  }
  return {
    id,
    fingerprint: String(row.fingerprint),
    severity: severity as VulnSeverity,
    category: String(row.category),
    subcategory: row.subcategory === null || row.subcategory === undefined ? null : String(row.subcategory),
    owaspIds: Array.isArray(row.owasp_ids) ? row.owasp_ids.map(String) : [],
    minRepro: { turns, ...(attemptId ? { attempt_id: attemptId } : {}) },
    targetVersion: String(row.target_version ?? transcript?.target.version ?? 'unknown'),
    discoveredAt: iso(row.created_at),
    ...optional,
  }
}

function mapRediscovery(row: Row): Rediscovery {
  const status = String(row.status)
  return {
    exploitId: String(row.exploit_id),
    latestVersion: Number(row.version),
    // A status outside the report workflow is carried as draft so a human looks at it.
    latestStatus: (REPORT_STATUSES.includes(status) ? status : 'draft') as VulnReportStatus,
    latestBody: row.body,
    entry: {
      event: 'rediscovered',
      at: iso(row.hit_at),
      target_version: String(row.target_version ?? 'unknown'),
      attempt_id: String(row.attempt_id),
    },
  }
}

/** The Documentation Agent's DB seam: reads exploits and attempts, writes only `reports` and `agent_events` (Section 14.4). */
export class PgDocsRepository implements DocsRepository {
  constructor(private readonly pool: pg.Pool) {}

  async listUnreportedExploits(): Promise<ConfirmedExploit[]> {
    const result = await this.pool.query(UNREPORTED_SQL)
    return result.rows.map(mapExploit)
  }

  async listRediscoveries(): Promise<Rediscovery[]> {
    const result = await this.pool.query(REDISCOVERIES_SQL)
    return result.rows.map(mapRediscovery)
  }

  /**
   * Version 1 is a new draft. A later version copies the previous row's
   * approval state, so a history update does not send a published report back
   * through the approvals queue. Report bodies are never rewritten in place.
   */
  async insertReport(row: ReportRow): Promise<boolean> {
    const result = await this.pool.query(
      `INSERT INTO reports (exploit_id, version, body, status, approved_by, published_at)
       SELECT $1, $2, $3::jsonb, coalesce(prev.status, 'draft'), prev.approved_by, prev.published_at
       FROM (SELECT 1) AS one
       LEFT JOIN reports prev ON prev.exploit_id = $1 AND prev.version = $2 - 1
       WHERE NOT EXISTS (SELECT 1 FROM reports r WHERE r.exploit_id = $1 AND r.version >= $2)`,
      [row.exploitId, row.version, JSON.stringify(row.body)],
    )
    return (result.rowCount ?? 0) > 0
  }

  async recordEvent(row: DocsEventRow): Promise<void> {
    await this.pool.query(
      `INSERT INTO agent_events (trace_id, agent, event_type, payload, source, cost_usd)
       VALUES ($1, 'documentation', $2, $3, 'documentation_agent', $4)`,
      [row.traceId, row.eventType, JSON.stringify(row.payload), row.costUsd],
    )
  }
}
