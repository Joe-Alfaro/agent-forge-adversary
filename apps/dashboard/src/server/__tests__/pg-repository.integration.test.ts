// @vitest-environment node
import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createPgRepository } from '../pg-repository.js'
import { resetDatabase, seedQueue, seedTickets } from './pg-seed.js'
import {
  contractNow,
  contractQueue,
  contractRunDate,
  contractTickets,
  describeRepositoryContract,
} from './repository-contract.js'

/*
 * Runs against a disposable Postgres migrated with packages/db. Skipped unless
 * DASHBOARD_TEST_DATABASE_URL is set; never point it at a shared database, the
 * suite truncates every platform table.
 */
const url = process.env.DASHBOARD_TEST_DATABASE_URL
const config = { envelopeUsd: 25, timeZone: 'America/Chicago', runHour: 1 }

describe.skipIf(!url)('Postgres repository', () => {
  const pool = new pg.Pool({ connectionString: url, max: 4 })

  afterAll(async () => {
    await pool.end()
  })

  async function seededRepo() {
    const versions = await resetDatabase(pool, ['copilot@9.0.0'])
    await seedTickets(pool, contractTickets, versions)
    await seedQueue(pool, contractQueue, contractRunDate)
    return createPgRepository({ pool, config, now: () => contractNow })
  }

  describeRepositoryContract('Postgres', { setup: seededRepo })

  describe('queue columns', () => {
    it('stores the rerun estimate and prefers stored estimates when reading', async () => {
      const repo = await seededRepo()
      await repo.enqueueRerun({
        schema_version: '1',
        message_id: '22222222-2222-4222-8222-222222222222',
        requested_by: 'operator',
        requested_for: contractRunDate,
        source: 'ui',
        target: { kind: 'exploit', exploit_id: 'AF-T-0001' },
      })
      const stored = await pool.query(`SELECT estimated_cost_usd FROM operator_requests WHERE id = '22222222-2222-4222-8222-222222222222'`)
      expect(Number(stored.rows[0]?.estimated_cost_usd)).toBe(0.6)
      await pool.query(`UPDATE operator_requests SET estimated_cost_usd = 7.5 WHERE kind = 'focus'`)
      expect((await repo.getQueue()).items[0]).toMatchObject({ kind: 'focus', estimatedCostUsd: 7.5 })
    })
  })

  describe('aggregates', () => {
    const repo = createPgRepository({ pool, config, now: () => contractNow })

    beforeEach(async () => {
      const versions = await resetDatabase(pool, ['copilot@9.0.0', 'copilot@9.1.0'])
      const v1 = versions.get('copilot@9.0.0')
      const v2 = versions.get('copilot@9.1.0')
      await pool.query(
        `INSERT INTO nightly_runs (id, scheduled_for, started_at, finished_at, trigger, spend_usd, status, summary) VALUES
         (1, '2026-09-28T06:00:00Z', '2026-09-28T06:00:00Z', '2026-09-28T08:00:00Z', 'cron', 30, 'completed',
          '{"target_version":"copilot@9.0.0","headline":"One regression","regressions":["AF-A-1"],"new_tickets":["AF-A-2"],"verified_fixes":[],"notes":["n1"],"queue":{"ran":2,"cut":1},"trace_url":"https://t/1","generated_at":"2026-09-28T08:05:00Z"}'),
         (2, '2026-09-29T06:00:00Z', '2026-09-29T06:00:00Z', NULL, 'run_now', 5.5, 'running', NULL)`,
      )
      await pool.query(`SELECT setval('nightly_runs_id_seq', 2)`)
      await pool.query(
        `INSERT INTO campaigns (id, nightly_run_id, plan, budget_usd) VALUES
         ('aaaaaaaa-0000-4000-8000-000000000001', 1, '{}', 10),
         ('aaaaaaaa-0000-4000-8000-000000000002', 2, '{}', 10)`,
      )
      // Run 1 on 9.0.0: three attempts (success, fail, fail). Run 2 on 9.1.0: two attempts (partial, success).
      await pool.query(
        `INSERT INTO attempts (id, campaign_id, fingerprint, category, subcategory, owasp_ids, transcript, target_version_id, created_at) VALUES
         ('bbbbbbbb-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001', 'fp-1', 'prompt_injection', 'direct', '{LLM01}', '{}', $1, '2026-09-28T06:10:00Z'),
         ('bbbbbbbb-0000-4000-8000-000000000002', 'aaaaaaaa-0000-4000-8000-000000000001', 'fp-x', 'prompt_injection', 'direct', '{LLM01}', '{}', $1, '2026-09-28T06:20:00Z'),
         ('bbbbbbbb-0000-4000-8000-000000000003', 'aaaaaaaa-0000-4000-8000-000000000001', 'fp-y', 'tool_misuse', NULL, '{LLM06}', '{}', $1, '2026-09-28T06:30:00Z'),
         ('bbbbbbbb-0000-4000-8000-000000000004', 'aaaaaaaa-0000-4000-8000-000000000002', 'fp-1', 'prompt_injection', 'direct', '{LLM01,LLM05}', '{}', $2, '2026-09-29T06:10:00Z'),
         ('bbbbbbbb-0000-4000-8000-000000000005', 'aaaaaaaa-0000-4000-8000-000000000002', 'fp-z', 'prompt_injection', 'indirect', '{LLM01}', '{}', $2, '2026-09-29T06:20:00Z')`,
        [v1, v2],
      )
      await pool.query(
        `INSERT INTO verdicts (attempt_id, outcome, confidence, stage, rubric_version, created_at) VALUES
         ('bbbbbbbb-0000-4000-8000-000000000001', 'success', 0.910, 'detector', 'r1', '2026-09-28T06:11:00Z'),
         ('bbbbbbbb-0000-4000-8000-000000000002', 'fail', 0.800, 'llm_primary', 'r1', '2026-09-28T06:21:00Z'),
         ('bbbbbbbb-0000-4000-8000-000000000003', 'fail', 0.700, 'llm_primary', 'r1', '2026-09-28T06:31:00Z'),
         ('bbbbbbbb-0000-4000-8000-000000000004', 'partial', 0.600, 'llm_primary', 'r1', '2026-09-29T06:11:00Z'),
         ('bbbbbbbb-0000-4000-8000-000000000005', 'success', 0.950, 'detector', 'r1', '2026-09-29T06:21:00Z')`,
      )
      await pool.query(
        `INSERT INTO exploits (id, fingerprint, severity, category, subcategory, owasp_ids, status, min_repro, family_ids, discovered_version_id, created_at) VALUES
         ('AF-A-1', 'fp-1', 'critical', 'prompt_injection', 'direct', '{LLM01}', 'regressed', '{}', '{bbbbbbbb-0000-4000-8000-000000000001,bbbbbbbb-0000-4000-8000-000000000004}', $1, '2026-09-28T06:12:00Z'),
         ('AF-A-2', 'fp-z', 'high', 'prompt_injection', 'indirect', '{LLM01}', 'false_positive', '{}', '{}', $2, '2026-09-29T06:22:00Z')`,
        [v1, v2],
      )
      await pool.query(
        `INSERT INTO agent_events (trace_id, agent, event_type, cost_usd, created_at) VALUES
         ('t1', 'judge', 'verdict', 4.5, '2026-09-28T06:11:00Z'),
         ('t1', 'target', 'call', 12, '2026-09-28T06:12:00Z'),
         ('t2', 'judge', 'verdict', 1.5, '2026-09-29T06:11:00Z'),
         ('t0', 'judge', 'verdict', 99, '2026-07-01T00:00:00Z')`,
      )
    })

    it('derives ticket confidence, last verdict, and last verified version from the family', async () => {
      const [ticket] = (await repo.listTickets()).filter((row) => row.id === 'AF-A-1')
      expect(ticket).toMatchObject({
        confidence: 0.91,
        familySize: 2,
        lastVerdict: 'partial',
        discoveredVersion: 'copilot@9.0.0',
        lastVerifiedVersion: 'copilot@9.1.0',
      })
    })

    it('lists runs newest first with verdict splits from their campaigns', async () => {
      const runs = await repo.listRuns()
      expect(runs.map((run) => run.id)).toEqual(['2', '1'])
      expect(runs[1]).toMatchObject({
        status: 'completed',
        attempts: 3,
        verdicts: { success: 1, partial: 0, fail: 2 },
        targetVersion: 'copilot@9.0.0',
        newTickets: 1,
        regressions: 1,
        spendUsd: 30,
        hasMorningReport: true,
        traceUrl: 'https://t/1',
      })
      expect(runs[0]).toMatchObject({ status: 'running', attempts: 2, hasMorningReport: false, newTickets: 1 })
    })

    it('serves the morning report from the run summary', async () => {
      expect(await repo.getMorningReport('1')).toMatchObject({
        headline: 'One regression',
        attempts: 3,
        queue: { ran: 2, cut: 1 },
        notes: ['n1'],
      })
      expect(await repo.getMorningReport('2')).toBeNull()
      expect(await repo.getMorningReport('not-a-number')).toBeNull()
    })

    it('builds coverage for the newest target version only', async () => {
      const coverage = await repo.getCoverage()
      expect(coverage.targetVersion).toBe('copilot@9.1.0')
      expect(coverage.cells).toEqual([
        {
          category: 'prompt_injection',
          subcategory: 'direct',
          owaspIds: ['LLM01', 'LLM05'],
          attempts: 1,
          confirmed: 1,
          lastRunAt: '2026-09-29T06:10:00.000Z',
        },
        {
          category: 'prompt_injection',
          subcategory: 'indirect',
          owaspIds: ['LLM01'],
          attempts: 1,
          confirmed: 0,
          lastRunAt: '2026-09-29T06:20:00.000Z',
        },
      ])
    })

    it('shows every taxonomy cell, untested ones with zero attempts', async () => {
      const withTaxonomy = createPgRepository({
        pool,
        config,
        now: () => contractNow,
        taxonomy: [
          { category: 'prompt_injection', subcategory: 'direct' },
          { category: 'state_corruption', subcategory: 'context_poisoning' },
        ],
      })
      const coverage = await withTaxonomy.getCoverage()
      expect(coverage.cells.map((cell) => [cell.category, cell.subcategory, cell.attempts])).toEqual([
        ['prompt_injection', 'direct', 1],
        ['state_corruption', 'context_poisoning', 0],
        ['prompt_injection', 'indirect', 1],
      ])
    })

    it('takes the last verified version from regression results when the harness has run', async () => {
      const versions = await pool.query<{ id: number }>(`SELECT id FROM target_versions WHERE version = 'copilot@9.0.0'`)
      const run = await pool.query<{ id: string }>(
        `INSERT INTO regression_runs (target_version_id, status, started_at) VALUES ($1, 'completed', '2026-09-30T02:00:00Z') RETURNING id`,
        [versions.rows[0]?.id],
      )
      await pool.query(
        `INSERT INTO regression_results (run_id, exploit_id, outcome, replay_count, majority, created_at)
         VALUES ($1, 'AF-A-1', 'fail', 3, 'fail', '2026-09-30T02:10:00Z')`,
        [run.rows[0]?.id],
      )
      expect((await repo.getTicket('AF-A-1'))?.lastVerifiedVersion).toBe('copilot@9.0.0')
    })

    it('reads coverage from coverage_snapshots once the Orchestrator has materialized them', async () => {
      const latest = await pool.query<{ id: number }>(`SELECT id FROM target_versions WHERE version = 'copilot@9.1.0'`)
      await pool.query(
        `INSERT INTO coverage_snapshots (target_version_id, category, subcategory, attempts, confirmed, last_run_at)
         VALUES ($1, 'prompt_injection', 'direct', 40, 2, '2026-09-29T07:00:00Z')`,
        [latest.rows[0]?.id],
      )
      const coverage = await repo.getCoverage()
      // 40 attempts on 2026-09-29 clears the M5 bar for prompt_injection/direct.
      expect(coverage.m5).toMatchObject({ covered: 1, coveredKeys: ['prompt_injection/direct'] })
      expect(coverage.cells).toEqual([
        {
          category: 'prompt_injection',
          subcategory: 'direct',
          owaspIds: ['LLM01', 'LLM05'],
          attempts: 40,
          confirmed: 2,
          lastRunAt: '2026-09-29T07:00:00.000Z',
        },
      ])
    })

    it('reports spend per run and per agent role for the last 30 days', async () => {
      const cost = await repo.getCost()
      expect(cost.byRun.map((run) => [run.runId, run.spendUsd])).toEqual([
        ['2', 5.5],
        ['1', 30],
      ])
      expect(cost.byRole).toEqual([
        { role: 'target', spendUsd: 12 },
        { role: 'judge', spendUsd: 6 },
      ])
      expect(cost.totalUsd).toBe(18)
      // Only completed runs feed the projection: $30 a night.
      expect(cost.projectedMonthlyUsd).toBe(900)
    })
  })
})
