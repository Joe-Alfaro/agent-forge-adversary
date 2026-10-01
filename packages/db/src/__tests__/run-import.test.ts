import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import type { AttackTranscript, CampaignPlan, Verdict } from '@agentforge/contracts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createIsolatedSchema, type IsolatedSchema } from './isolated-schema.js'

import { importPlan } from '../import-writer.js'
import { planRunImport, type RunArtifact } from '../run-import.js'

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url))
const evalFile = JSON.parse(
  readFileSync(`${repoRoot}evals/results/2026-09-29-copilot-c1f011e.json`, 'utf8'),
) as { cases: { transcript: AttackTranscript }[] }

const TARGET = { name: 'copilot', base_url: 'https://copilot.test/', version: 'copilot@test1' }
const CAMPAIGN_ID = '11111111-1111-4111-8111-111111111111'
const ROOT_ID = '22222222-2222-4222-8222-222222222222'
const CHILD_ID = '33333333-3333-4333-8333-333333333333'

function transcript(attemptId: string): AttackTranscript {
  return { ...evalFile.cases[0]!.transcript, campaign_id: CAMPAIGN_ID, attempt_id: attemptId }
}

function verdict(attemptId: string, outcome: Verdict['outcome']): Verdict {
  return {
    schema_version: '1',
    message_id: attemptId.replace(/^.{8}/, '44444444'),
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

const plan: CampaignPlan = {
  schema_version: '1',
  message_id: '55555555-5555-4555-8555-555555555555',
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
}

function artifact(overrides: Partial<RunArtifact> = {}): RunArtifact {
  return {
    schema_version: '1',
    run_key: 'run-now-test-1',
    trigger: 'run_now',
    status: 'completed',
    started_at: '2026-09-29T23:00:00.000Z',
    finished_at: '2026-09-29T23:10:00.000Z',
    target: TARGET,
    spend_usd: 0.21,
    campaigns: [
      {
        plan,
        spend_usd: 0.2,
        status: 'completed',
        attempts: [
          {
            transcript: transcript(ROOT_ID),
            fingerprint: 'fp-root',
            category: 'data_exfiltration',
            subcategory: 'phi_leakage',
            owasp_ids: ['LLM02', 'A01'],
            technique_tags: ['canary'],
            cost_usd: 0.01,
            verdicts: [verdict(ROOT_ID, 'fail')],
          },
          {
            transcript: transcript(CHILD_ID),
            parent_attempt_id: ROOT_ID,
            fingerprint: 'fp-child',
            category: 'data_exfiltration',
            subcategory: 'phi_leakage',
            owasp_ids: ['LLM02', 'A01'],
            technique_tags: ['canary', 'persona_swap'],
            verdicts: [verdict(CHILD_ID, 'success')],
          },
        ],
      },
    ],
    exploits: [
      {
        // Ignored by the importer: ids come from agentforge_exploit_seq.
        id: 'AF-ARTIFACT-IGNORED',
        fingerprint: 'fp-child',
        severity: 'high',
        category: 'data_exfiltration',
        subcategory: 'phi_leakage',
        owasp_ids: ['LLM02', 'A01'],
        min_repro: { turns: ['...'] },
        family_ids: [ROOT_ID, CHILD_ID],
        report: { body: { title: 'Canary leak' } },
      },
    ],
    agent_events: [
      { trace_id: 'trace-1', agent: 'redteam', event_type: 'attempt', cost_usd: 0.15, created_at: '2026-09-29T23:01:00.000Z' },
      { trace_id: 'trace-1', agent: 'judge', event_type: 'verdict', cost_usd: 0.06, created_at: '2026-09-29T23:05:00.000Z' },
    ],
    // Counts from the emitter's own database. The importer must not trust them.
    coverage: [
      { category: 'data_exfiltration', subcategory: 'phi_leakage', attempts: 99, confirmed: 5, families_exercised: 9, last_run_at: '2020-01-01T00:00:00.000Z' },
    ],
    ...overrides,
  }
}

describe('planRunImport', () => {
  it('maps campaigns, attempts with lineage, verdicts, exploits, and events', () => {
    const result = planRunImport(artifact())
    expect(result.importKey).toBe('run-import:run-now-test-1')
    expect(result.campaigns).toEqual([
      expect.objectContaining({ id: CAMPAIGN_ID, budgetUsd: 0.5, spendUsd: 0.2, status: 'completed' }),
    ])
    expect(result.attempts.map((attempt) => [attempt.id, attempt.parentAttemptId])).toEqual([
      [ROOT_ID, null],
      [CHILD_ID, ROOT_ID],
    ])
    expect(result.attempts[1]!.verdicts[0]).toMatchObject({ outcome: 'success', stage: 'detector' })
    expect(result.exploits[0]).toMatchObject({ fingerprint: 'fp-child', report: { title: 'Canary leak' } })
    expect(result.exploits[0]).not.toHaveProperty('id')
    expect(result.events).toHaveLength(2)
  })

  it('derives a valid morning report when the artifact has none', () => {
    const summary = planRunImport(artifact()).run.summary
    // new_tickets is filled in by the writer with the ids it assigns.
    expect(summary).toMatchObject({ target_version: 'copilot@test1', new_tickets: [] })
    expect(summary.headline).toContain('1 confirmed')
  })

  it('rejects contract violations with the path of the bad object', () => {
    const bad = artifact()
    bad.campaigns[0]!.attempts[0]!.verdicts[0]!.confidence = 2
    expect(() => planRunImport(bad)).toThrow('campaigns[0].attempts[0].verdicts[0]')
  })

  it('rejects cells outside AttackTaxonomy v1', () => {
    const bad = artifact()
    bad.campaigns[0]!.attempts[0]!.subcategory = 'made_up'
    expect(() => planRunImport(bad)).toThrow('made_up')
  })

  it('rejects an attempt whose transcript belongs to another campaign', () => {
    const bad = artifact()
    bad.campaigns[0]!.attempts[0]!.transcript = { ...transcript(ROOT_ID), campaign_id: ROOT_ID }
    expect(() => planRunImport(bad)).toThrow('campaign')
  })
})

// Needs a Postgres it may create schemas in. Each run migrates its own throwaway
// schema and drops it afterwards, so it never touches `public` or other suites.
const testDbUrl = process.env.DB_TEST_DATABASE_URL

describe.skipIf(!testDbUrl)('importPlan for a run artifact (Postgres)', () => {
  let isolated: IsolatedSchema
  let pool: IsolatedSchema['pool']

  beforeAll(async () => {
    isolated = await createIsolatedSchema(testDbUrl!)
    pool = isolated.pool
  })

  afterAll(() => isolated?.drop())

  it('imports once, is a no-op on re-import, and keeps operator ticket state on a later run', async () => {
    const queued = await pool.query<{ id: string }>(
      `INSERT INTO operator_requests (kind, category, requested_by, source) VALUES ('focus', 'data_exfiltration', 'operator', 'ui') RETURNING id`,
    )
    const requestId = queued.rows[0]!.id
    const first = await importPlan(pool, planRunImport(artifact({ queue_request_ids: [requestId] })))
    const again = await importPlan(pool, planRunImport(artifact()))
    expect(first.status).toBe('imported')
    expect(again).toEqual({ status: 'already_imported', runId: first.runId })

    const coverage = () =>
      pool.query(
        `SELECT category, subcategory, attempts, confirmed, families_exercised, last_run_at
         FROM coverage_snapshots ORDER BY category, subcategory`,
      )
    // Recomputed from this database's attempts and exploits, not the artifact's 99/5/9.
    expect((await coverage()).rows).toEqual([
      {
        category: 'data_exfiltration',
        subcategory: 'phi_leakage',
        attempts: 2,
        confirmed: 1,
        families_exercised: 1,
        last_run_at: new Date(evalFile.cases[0]!.transcript.produced_at),
      },
    ])

    const request = await pool.query('SELECT status, nightly_run_id FROM operator_requests WHERE id = $1', [requestId])
    expect(request.rows[0]).toEqual({ status: 'ran', nightly_run_id: first.runId })

    const minted = await pool.query<{ id: string }>(`SELECT id FROM exploits WHERE fingerprint = 'fp-child'`)
    const ticketId = minted.rows[0]!.id
    expect(ticketId).toMatch(new RegExp(`^AF-${new Date().getFullYear()}-\\d{4}$`))
    expect(ticketId).not.toBe('AF-ARTIFACT-IGNORED')
    const firstSummary = await pool.query(`SELECT summary->'new_tickets' AS t FROM nightly_runs WHERE id = $1`, [first.runId])
    expect(firstSummary.rows[0].t).toEqual([ticketId])

    await pool.query(`UPDATE exploits SET status = 'in_progress', assignee = 'dana' WHERE id = $1`, [ticketId])
    const laterChild = '66666666-6666-4666-8666-666666666666'
    const later = artifact({ run_key: 'run-now-test-2' })
    const laterCampaign = { ...later.campaigns[0]!, plan: { ...plan, campaign_id: '77777777-7777-4777-8777-777777777777' } }
    laterCampaign.attempts = [
      {
        ...laterCampaign.attempts[1]!,
        parent_attempt_id: ROOT_ID,
        transcript: { ...transcript(laterChild), campaign_id: laterCampaign.plan.campaign_id },
        verdicts: [{ ...verdict(laterChild, 'success'), campaign_id: laterCampaign.plan.campaign_id, message_id: '88888888-8888-4888-8888-888888888888' }],
      },
    ]
    later.campaigns = [laterCampaign]
    later.exploits = [{ ...later.exploits![0]!, family_ids: [laterChild] }]
    const second = await importPlan(pool, planRunImport(later))
    const secondSummary = await pool.query(`SELECT summary->'new_tickets' AS t FROM nightly_runs WHERE id = $1`, [second.runId])
    expect(secondSummary.rows[0].t).toEqual([])

    const ticket = await pool.query(`SELECT id, status, assignee, family_ids FROM exploits WHERE fingerprint = 'fp-child'`)
    expect(ticket.rows[0].id).toBe(ticketId)
    expect(ticket.rows[0]).toMatchObject({ status: 'in_progress', assignee: 'dana' })
    expect([...ticket.rows[0].family_ids].sort()).toEqual([ROOT_ID, CHILD_ID, laterChild].sort())

    const counts = await pool.query(`
      SELECT (SELECT count(*) FROM nightly_runs)::int AS runs,
             (SELECT count(*) FROM attempts)::int AS attempts,
             (SELECT count(*) FROM verdicts)::int AS verdicts,
             (SELECT count(*) FROM reports)::int AS reports,
             (SELECT count(*) FROM agent_events)::int AS events`)
    expect(counts.rows[0]).toEqual({ runs: 2, attempts: 3, verdicts: 3, reports: 1, events: 4 })
    // The later run's attempt adds to the cell's total in this database.
    expect((await coverage()).rows[0]).toMatchObject({ attempts: 3, confirmed: 1, families_exercised: 1 })
  })
})
