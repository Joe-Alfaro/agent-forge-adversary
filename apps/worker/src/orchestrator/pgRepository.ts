import type pg from 'pg'

import { PgPlanningRepository, type CoverageCellInput, type QueuedRequest, type RegressionOwed } from '@agentforge/planner'
import type {
  AttemptRow,
  CoverageSnapshotRow,
  ExploitRow,
  OrchestratorRepository,
  RegressionFamily,
  RegressionResultRow,
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


export class PgOrchestratorRepository implements OrchestratorRepository {
  /** The planner's read side (@agentforge/planner); the methods below delegate to it. */
  private readonly planning: PgPlanningRepository

  constructor(private readonly pool: Queryable) {
    this.planning = new PgPlanningRepository(pool)
  }

  findStandingPlan() {
    return this.planning.findStandingPlan()
  }

  getNightlyBudgetUsd() {
    return this.planning.getNightlyBudgetUsd()
  }

  previewOperatorRequests(runDate: string): Promise<QueuedRequest[]> {
    return this.planning.previewOperatorRequests(runDate)
  }

  findTargetVersion(version?: string) {
    return this.planning.findTargetVersion(version)
  }

  lastFinishedRun() {
    return this.planning.lastFinishedRun()
  }

  getOwedRegressions(args: { targetChanged: boolean; since: string | null }): Promise<RegressionOwed[]> {
    return this.planning.getOwedRegressions(args)
  }

  getCoverageCells(targetVersionId: number, predictedCostUsd: number): Promise<CoverageCellInput[]> {
    return this.planning.getCoverageCells(targetVersionId, predictedCostUsd)
  }

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

  async claimScheduledCron(id?: number): Promise<{ nightlyRunId: number; plan: unknown } | null> {
    // Same row the dashboard's Tonight's queue reads: latest by scheduled_for DESC, id DESC.
    const result = await this.pool.query(
      `UPDATE nightly_runs SET status = 'running', started_at = now()
       WHERE id = (
         SELECT id FROM nightly_runs
         WHERE trigger = 'cron' AND status = 'scheduled'${id === undefined ? '' : ' AND id = $1'}
         ORDER BY scheduled_for DESC, id DESC
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

  /**
   * The exploit's minimal reproduction, then each stored family attempt whose
   * latest verdict was `success` (the successful variants, ARCHITECTURE 9.1),
   * deduplicated by turn sequence. OWASP ids come from the exploit, falling back
   * to those recorded on its family's attempts.
   */
  async getRegressionFamily(exploitId: string): Promise<RegressionFamily | null> {
    const exploit = await this.pool.query(
      'SELECT id, category, subcategory, status, owasp_ids, min_repro, family_ids, fingerprint FROM exploits WHERE id = $1',
      [exploitId],
    )
    const row = exploit.rows[0]
    if (!row) return null
    const variants = await this.pool.query(
      `SELECT a.transcript, a.owasp_ids
       FROM attempts a
       JOIN LATERAL (
         SELECT v.outcome FROM verdicts v WHERE v.attempt_id = a.id ORDER BY v.created_at DESC LIMIT 1
       ) lv ON true
       WHERE (a.id = ANY($1::uuid[]) OR a.fingerprint = $2) AND lv.outcome = 'success'
       ORDER BY a.created_at, a.id`,
      [row.family_ids ?? [], row.fingerprint],
    )
    const repro = row.min_repro as { turns?: unknown } | null
    const minTurns = Array.isArray(repro?.turns) ? repro.turns.filter((t): t is string => typeof t === 'string') : []
    const variantTurns = variants.rows.map((v) => {
      const turns = (v.transcript as { turns?: { attacker_message?: unknown }[] } | null)?.turns ?? []
      return turns.map((t) => t.attacker_message).filter((m): m is string => typeof m === 'string')
    })
    const seen = new Set<string>()
    const sequences = [
      ...(minTurns.length > 0 ? [{ label: 'min_repro' as const, turns: minTurns }] : []),
      ...variantTurns.filter((t) => t.length > 0).map((turns) => ({ label: 'variant' as const, turns })),
    ].filter((seq) => {
      const key = JSON.stringify(seq.turns)
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    const exploitOwasp = Array.isArray(row.owasp_ids) ? row.owasp_ids.map(String) : []
    const attemptOwasp = [...new Set(variants.rows.flatMap((v) => (Array.isArray(v.owasp_ids) ? v.owasp_ids.map(String) : [])))]
    return {
      exploitId: String(row.id),
      category: String(row.category),
      ...(row.subcategory ? { subcategory: String(row.subcategory) } : {}),
      status: String(row.status),
      owaspIds: exploitOwasp.length > 0 ? exploitOwasp : attemptOwasp,
      sequences,
    }
  }

  async createRegressionRun(row: { targetVersionId: number; scope: 'full' | 'targeted' }): Promise<string> {
    const result = await this.pool.query(
      `INSERT INTO regression_runs (target_version_id, scope, status) VALUES ($1, $2, 'running') RETURNING id`,
      [row.targetVersionId, row.scope],
    )
    return String(result.rows[0]?.id)
  }

  async insertRegressionResult(row: RegressionResultRow): Promise<void> {
    await this.pool.query(
      `INSERT INTO regression_results (run_id, exploit_id, outcome, replay_count, majority) VALUES ($1, $2, $3, $4, $5)`,
      [row.runId, row.exploitId, row.outcome, row.replayCount, row.majority],
    )
  }

  async finishRegressionRun(id: string, status: string): Promise<void> {
    await this.pool.query('UPDATE regression_runs SET status = $2, finished_at = now() WHERE id = $1', [id, status])
  }

  // ---- Read side, used by the Run-now entrypoint to build a plan ----

  /**
   * Drains the operator queue in the documented order: position NULLS LAST,
   * created_at. Each row's `estimated_cost_usd` (the dashboard's family-size
   * estimate) is carried so reruns consume the envelope in the run/cut decision.
   */
  async drainOperatorRequests(runDate: string, singleId?: string): Promise<QueuedRequest[]> {
    const result = await this.pool.query(
      `SELECT id, kind, exploit_id, category, reason, estimated_cost_usd
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
      ...(r.estimated_cost_usd === null || r.estimated_cost_usd === undefined ? {} : { estimatedCostUsd: Number(r.estimated_cost_usd) }),
    }))
  }
}
