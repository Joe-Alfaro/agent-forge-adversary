// @vitest-environment node
import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createPgRepository } from '../pg-repository.js'
import { resetDatabase, seedQueue, seedTickets, setQueuePositionColumn } from './pg-seed.js'
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
    await setQueuePositionColumn(pool, false)
    await pool.end()
  })

  async function seededRepo(withPositions: boolean) {
    await setQueuePositionColumn(pool, withPositions)
    const versions = await resetDatabase(pool, ['copilot@9.0.0'])
    await seedTickets(pool, contractTickets, versions)
    await seedQueue(pool, contractQueue, contractRunDate, withPositions)
    return createPgRepository({ pool, config, now: () => contractNow })
  }

  describeRepositoryContract('Postgres without operator_requests.position', {
    setup: () => seededRepo(false),
    supportsReorder: () => false,
  })

  describeRepositoryContract('Postgres with operator_requests.position', {
    setup: () => seededRepo(true),
    supportsReorder: () => true,
  })

  describe('aggregates', () => {
    const repo = createPgRepository({ pool, config, now: () => contractNow })

    beforeAll(async () => {
      await setQueuePositionColumn(pool, false)
    })

    beforeEach(async () => {
      const versions = await resetDatabase(pool, ['copilot@9.0.0', 'copilot@9.1.0'])
      const v1 = versions.get('copilot@9.0.0')
      const v2 = versions.get('copilot@9.1.0')
      await pool.query(
        `INSERT INTO nightly_runs (id, scheduled_for, started_at, finished_at, trigger, spend_usd, status, summary) VALUES
         (1, '2026-09-28T06:00:00Z', '2026-09-28T06:00:00Z', '2026-09-28T08:00:00Z', 'cron', 30, 'completed',
          '{"headline":"One regression","regressions":["AF-A-1"],"new_tickets":["AF-A-2"],"notes":["n1"],"queue":{"ran":2,"cut":1},"trace_url":"https://t/1"}'),
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

    it('adds untested cells from the eval taxonomy without hard-coding categories', async () => {
      const withTaxonomy = createPgRepository({
        pool,
        config,
        now: () => contractNow,
        loadTaxonomy: async () => [
          { category: 'prompt_injection', subcategory: 'direct', owaspIds: ['LLM07'] },
          { category: 'state_corruption', subcategory: 'memory_poisoning', owaspIds: ['LLM04'] },
        ],
      })
      const coverage = await withTaxonomy.getCoverage()
      expect(coverage.cells.map((cell) => [cell.category, cell.subcategory, cell.attempts])).toEqual([
        ['prompt_injection', 'direct', 1],
        ['prompt_injection', 'indirect', 1],
        ['state_corruption', 'memory_poisoning', 0],
      ])
      expect(coverage.cells[0]?.owaspIds).toEqual(['LLM01', 'LLM05', 'LLM07'])
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
