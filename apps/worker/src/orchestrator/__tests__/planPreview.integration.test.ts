// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { runner } from 'node-pg-migrate'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { validateNightlyPlan, type AttackTranscript, type NightlyPlan, type Verdict } from '@agentforge/contracts'
import { importPlan, planRunImport, type RunArtifact } from '@agentforge/db'

import { loadEvalSuite } from '../../evals/index.js'
import { previewNightlyPlan, readPlanPreviewConfig } from '../planPreview.js'

/*
 * Runs plan:preview's importable core against a real Postgres: a freshly
 * migrated, uniquely named schema (never `public`), dropped afterwards, so it is
 * safe alongside other suites. Skipped unless PLAN_PREVIEW_TEST_DATABASE_URL
 * (or ORCH_TEST_DATABASE_URL) is set.
 */
const url = process.env.PLAN_PREVIEW_TEST_DATABASE_URL ?? process.env.ORCH_TEST_DATABASE_URL

const repoRoot = fileURLToPath(new URL('../../../../../', import.meta.url))
const seeds = loadEvalSuite(`${repoRoot}evals/seeds`)
const evalFile = JSON.parse(readFileSync(`${repoRoot}evals/results/2026-09-29-copilot-c1f011e.json`, 'utf8')) as {
  cases: { transcript: AttackTranscript }[]
}

const TARGET = { name: 'copilot', base_url: 'https://copilot.test/', version: 'copilot@test1' }
const CAMPAIGN_ID = '11111111-1111-4111-8111-111111111111'
const ROOT_ID = '22222222-2222-4222-8222-222222222222'
const CHILD_ID = '33333333-3333-4333-8333-333333333333'
const RERUN_EXPLOIT_REQ = '44444444-4444-4444-8444-444444444444'
const RERUN_CATEGORY_REQ = '55555555-5555-4555-8555-555555555555'
const CANCELLED_REQ = '66666666-6666-4666-8666-666666666666'

function verdict(attemptId: string, outcome: Verdict['outcome']): Verdict {
  return {
    schema_version: '1',
    message_id: randomUUID(),
    campaign_id: CAMPAIGN_ID,
    trace_id: 'trace-1',
    attempt_id: attemptId,
    produced_by: 'judge',
    produced_at: '2026-09-29T23:05:00.000Z',
    target_version: TARGET.version,
    outcome,
    confidence: 0.9,
    stage: 'detector',
    rubric_version: 'data_exfiltration@test',
    evidence: [{ kind: 'detector_hit', ref: 'phi_canary' }],
    needs_review: false,
  }
}

function importedRun(): RunArtifact {
  const attempt = (id: string, fingerprint: string, outcome: Verdict['outcome'], parent?: string) => ({
    transcript: { ...evalFile.cases[0]!.transcript, campaign_id: CAMPAIGN_ID, attempt_id: id },
    ...(parent ? { parent_attempt_id: parent } : {}),
    fingerprint,
    category: 'data_exfiltration',
    subcategory: 'phi_leakage',
    owasp_ids: ['LLM02', 'A01'],
    verdicts: [verdict(id, outcome)],
  })
  return {
    schema_version: '1',
    run_key: `plan-preview-int-${randomUUID()}`,
    trigger: 'run_now',
    status: 'completed',
    started_at: '2026-09-29T23:00:00.000Z',
    finished_at: '2026-09-29T23:10:00.000Z',
    target: TARGET,
    spend_usd: 0.2,
    campaigns: [
      {
        plan: {
          schema_version: '1',
          message_id: randomUUID(),
          campaign_id: CAMPAIGN_ID,
          trace_id: 'trace-1',
          produced_by: 'orchestrator',
          produced_at: '2026-09-29T23:00:00.000Z',
          category: 'data_exfiltration',
          subcategory: 'phi_leakage',
          owasp_llm_ids: ['LLM02'],
          owasp_ids: ['A01'],
          seed_case_ids: ['dx-001'],
          max_attempts: 5,
          max_turns: 2,
          budget: { tokens: 50000, usd: 0.5 },
          target_version: TARGET.version,
        },
        spend_usd: 0.2,
        status: 'completed',
        attempts: [attempt(ROOT_ID, 'fp-root', 'fail'), attempt(CHILD_ID, 'fp-child', 'success', ROOT_ID)],
      },
    ],
    exploits: [
      {
        fingerprint: 'fp-child',
        severity: 'critical',
        category: 'data_exfiltration',
        subcategory: 'phi_leakage',
        owasp_ids: ['LLM02', 'A01'],
        min_repro: { turns: ['...'] },
        family_ids: [ROOT_ID, CHILD_ID],
      },
    ],
  }
}

async function scheduledCronRows(pool: pg.Pool): Promise<{ id: number; plan: NightlyPlan; scheduled_for: Date }[]> {
  const result = await pool.query(
    `SELECT id, plan, scheduled_for FROM nightly_runs WHERE trigger = 'cron' AND status = 'scheduled' ORDER BY id`,
  )
  return result.rows.map((r) => ({ id: Number(r.id), plan: r.plan as NightlyPlan, scheduled_for: r.scheduled_for as Date }))
}

describe.skipIf(!url)('plan:preview against Postgres (dry run)', () => {
  const schema = `af_test_${randomUUID().replaceAll('-', '').slice(0, 16)}`
  let pool: pg.Pool
  let exploitId: string
  // Envelope $1.00: reruns $0.30 + $0.15 and one $0.15 regression, then $0.20 coverage campaigns.
  const config = {
    ...readPlanPreviewConfig({}),
    budgetUsd: 1,
    costPerAttemptUsd: 0.05,
    maxAttemptsPerCampaign: 4,
    topK: 6,
  }
  const now = new Date('2026-09-30T02:00:00Z')

  beforeAll(async () => {
    await runner({
      databaseUrl: url!,
      dir: fileURLToPath(new URL('../../../../../packages/db/migrations', import.meta.url)),
      direction: 'up',
      migrationsTable: 'pgmigrations',
      schema,
      createSchema: true,
      noLock: true,
      log: () => {},
    })
    pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}`, max: 4 })

    const imported = await importPlan(pool, planRunImport(importedRun()))
    expect(imported.status).toBe('imported')
    const exploit = await pool.query(`SELECT id FROM exploits WHERE fingerprint = 'fp-child'`)
    exploitId = String(exploit.rows[0]?.id)

    // A ticket moved to fixed after the imported run: a regression is owed.
    const tv = await pool.query('SELECT id FROM target_versions WHERE version = $1', [TARGET.version])
    await pool.query(
      `INSERT INTO exploits (id, fingerprint, severity, category, subcategory, owasp_ids, status, min_repro, discovered_version_id, updated_at)
       VALUES ('AF-2026-9001', 'fp-fixed', 'high', 'prompt_injection', 'indirect', '{}', 'fixed', '{"turns":["x"]}', $1, '2026-09-30T00:00:00Z')`,
      [tv.rows[0]?.id],
    )
    await pool.query(
      `INSERT INTO operator_requests (id, kind, exploit_id, category, requested_by, source, status, position, estimated_cost_usd) VALUES
       ($1, 'rerun', $2, NULL, 'priya', 'ui', 'queued', 1, 0.30),
       ($3, 'rerun', NULL, 'tool_misuse', 'priya', 'chat', 'queued', 2, NULL),
       ($4, 'rerun', NULL, 'misinformation', 'priya', 'ui', 'cancelled', 3, 0.10)`,
      [RERUN_EXPLOIT_REQ, exploitId, RERUN_CATEGORY_REQ, CANCELLED_REQ],
    )
  })

  afterAll(async () => {
    await pool?.end()
    if (!url) return
    const admin = new pg.Client({ connectionString: url })
    await admin.connect()
    try {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
    } finally {
      await admin.end()
    }
  })

  it('writes one scheduled cron row whose plan follows 7.0 order with OWASP ids and run/cut vs the envelope', async () => {
    const result = await previewNightlyPlan({ pool, seeds, config, now })
    expect(result.created).toBe(true)
    expect(result.scheduledFor).toBe('2026-09-30T06:00:00.000Z')

    const rows = await scheduledCronRows(pool)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.id).toBe(result.nightlyRunId)
    expect(rows[0]?.scheduled_for.toISOString()).toBe('2026-09-30T06:00:00.000Z')
    const plan = rows[0]!.plan
    expect(validateNightlyPlan(plan).errors).toEqual([])
    expect(plan.trigger).toBe('cron')
    expect(plan.target_version).toBe(TARGET.version)
    expect(plan.budget_usd).toBe(1)

    // (a) queued operator reruns in queue order (cancelled one excluded), (b) the owed regression, (c) coverage.
    expect(plan.items.map((i) => i.kind)).toEqual([
      'operator_request',
      'operator_request',
      'regression',
      ...Array<string>(6).fill('coverage_campaign'),
    ])
    expect(plan.items[0]).toMatchObject({
      request_id: RERUN_EXPLOIT_REQ,
      exploit_id: exploitId,
      category: 'data_exfiltration',
      subcategory: 'phi_leakage',
      owasp_ids: ['LLM02', 'A01'],
      estimated_cost_usd: 0.3,
    })
    expect(plan.items[1]).toMatchObject({ request_id: RERUN_CATEGORY_REQ, category: 'tool_misuse', estimated_cost_usd: 0.15 })
    expect(plan.items[2]).toMatchObject({ kind: 'regression', exploit_id: 'AF-2026-9001', regression_cause: 'ticket_fixed', estimated_cost_usd: 0.15 })
    // The regression's exploit stores no OWASP ids, so the cell mapping is used.
    expect(plan.items[2]?.owasp_ids).toEqual(expect.arrayContaining(['LLM01']))

    const coverage = plan.items.filter((i) => i.kind === 'coverage_campaign')
    coverage.forEach((item) => {
      expect(item.owasp_ids?.length).toBeGreaterThan(0)
      expect(item.score).toBeDefined()
      expect(item.priority).toEqual(expect.any(Number))
      expect(item.estimated_cost_usd).toBeCloseTo(0.2, 6)
    })
    // Sorted by priority, highest first.
    const priorities = coverage.map((i) => i.priority!)
    expect([...priorities].sort((a, b) => b - a)).toEqual(priorities)
    // The imported cell carries an open critical finding, which outweighs its partial coverage.
    expect(coverage[0]).toMatchObject({ category: 'data_exfiltration', subcategory: 'phi_leakage', owasp_ids: ['LLM02', 'A01'] })
    expect(coverage[0]?.score).toMatchObject({ gap: 0.8, open: 1 })

    // $0.30 + $0.15 + $0.15 = $0.60, then two $0.20 campaigns fill the $1.00 envelope; the rest are cut.
    expect(plan.items.map((i) => i.decision)).toEqual(['run', 'run', 'run', 'run', 'run', 'cut', 'cut', 'cut', 'cut'])
    expect(plan.run_count).toBe(5)
    expect(plan.cut_count).toBe(4)
    expect(plan.estimated_cost_usd).toBeCloseTo(1, 6)
    plan.items.filter((i) => i.decision === 'cut').forEach((i) => expect(i.reason).toMatch(/over budget envelope/))
  })

  it('is idempotent: re-running refreshes the same scheduled row and changes nothing else', async () => {
    const before = await scheduledCronRows(pool)
    const again = await previewNightlyPlan({ pool, seeds, config: { ...config, budgetUsd: 25 }, now })
    expect(again.created).toBe(false)
    const after = await scheduledCronRows(pool)
    expect(after).toHaveLength(1)
    expect(after[0]?.id).toBe(before[0]?.id)
    expect(after[0]?.plan.message_id).not.toBe(before[0]?.plan.message_id)
    expect(after[0]?.plan.budget_usd).toBe(25)
    expect(after[0]?.plan.cut_count).toBe(0)

    // Dry run: nothing executed, nothing spent, the queue is not drained.
    const attempts = await pool.query('SELECT count(*)::int AS n FROM attempts')
    expect(attempts.rows[0]?.n).toBe(2)
    const campaigns = await pool.query('SELECT count(*)::int AS n FROM campaigns')
    expect(campaigns.rows[0]?.n).toBe(1)
    const queued = await pool.query(`SELECT count(*)::int AS n FROM operator_requests WHERE status = 'queued'`)
    expect(queued.rows[0]?.n).toBe(2)
    const runs = await pool.query('SELECT count(*)::int AS n, sum(spend_usd)::float AS spend FROM nightly_runs')
    expect(runs.rows[0]?.n).toBe(2)
    expect(runs.rows[0]?.spend).toBeCloseTo(0.2, 6)
  })

  it('owes the full regression suite when the target version changed since the last run', async () => {
    await pool.query(
      `INSERT INTO target_versions (target_id, version, first_seen)
       SELECT target_id, 'copilot@test2', now() FROM target_versions WHERE version = $1`,
      [TARGET.version],
    )
    const result = await previewNightlyPlan({ pool, seeds, config: { ...config, budgetUsd: 25 }, now })
    const plan = result.plan
    expect(plan.target_version).toBe('copilot@test2')
    const regressions = plan.items.filter((i) => i.kind === 'regression')
    // The imported exploit is already queued as a rerun, so only the fixed ticket is added, once, as a target-change regression.
    expect(regressions.map((r) => [r.exploit_id, r.regression_cause])).toEqual([['AF-2026-9001', 'target_changed']])
    expect(plan.notes?.some((n) => n.includes('copilot@test1 -> copilot@test2'))).toBe(true)
    expect(await scheduledCronRows(pool)).toHaveLength(1)
  })

  it('refreshes the row the dashboard reads (latest scheduled cron row by scheduled_for DESC, id DESC)', async () => {
    // A stray later-dated scheduled cron row must not shadow the refreshed plan.
    await pool.query(
      `INSERT INTO nightly_runs (scheduled_for, trigger, status, plan) VALUES ('2026-10-05T06:00:00Z', 'cron', 'scheduled', '{}')`,
    )
    const result = await previewNightlyPlan({ pool, seeds, config, now })
    const read = await pool.query(
      `SELECT id, plan FROM nightly_runs WHERE trigger = 'cron' AND status = 'scheduled'
       ORDER BY scheduled_for DESC, id DESC LIMIT 1`,
    )
    expect(Number(read.rows[0]?.id)).toBe(result.nightlyRunId)
    expect((read.rows[0]?.plan as NightlyPlan).message_id).toBe(result.plan.message_id)
    expect(result.created).toBe(false)
  })
})
