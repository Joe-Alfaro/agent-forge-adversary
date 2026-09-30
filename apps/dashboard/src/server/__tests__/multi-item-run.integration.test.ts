// @vitest-environment node
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import type { AttackTranscript, CampaignPlan, Verdict } from '@agentforge/contracts'
import { importPlan, planRunImport, type RunArtifact, type RunArtifactAttempt } from '@agentforge/db'
import type pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { buildTrendSeries } from '../../lib/resilience.js'
import { createPgRepository } from '../pg-repository.js'
import type { DashboardRepository } from '../repository.js'
import { createIsolatedSchema, type IsolatedSchema } from './pg-schema.js'

/*
 * Every dashboard view against one realistic multi-item run, written by the
 * real run importer (@agentforge/db), not hand-seeded rows: three campaigns in
 * three categories, seven attempts with variant lineage, two confirmed
 * exploits with report drafts, a needs_review verdict, per-category rubrics,
 * and agent events. Skipped unless DASHBOARD_TEST_DATABASE_URL is set.
 */
const url = process.env.DASHBOARD_TEST_DATABASE_URL
const config = { envelopeUsd: 25, timeZone: 'America/Chicago', runHour: 1 }
const NOW = new Date('2026-09-30T12:00:00Z')

const repoRoot = fileURLToPath(new URL('../../../../../', import.meta.url))
const evalCases = (
  JSON.parse(readFileSync(`${repoRoot}evals/results/2026-09-29-copilot-c1f011e.json`, 'utf8')) as {
    cases: { transcript: AttackTranscript }[]
  }
).cases

const TARGET = { name: 'copilot', base_url: 'https://copilot.multi.test/', version: 'copilot@multi' }
const TRACE_URL = 'https://langfuse.test/trace/multi-run'

function uuid(prefix: string, n: number): string {
  return `${prefix}000000-0000-4000-8000-${String(n).padStart(12, '0')}`
}

const CAMPAIGNS = {
  exfil: uuid('c1', 1),
  injection: uuid('c2', 2),
  tools: uuid('c3', 3),
}

function transcript(campaignId: string, attemptId: string): AttackTranscript {
  const base = evalCases[0]?.transcript
  if (!base) {
    throw new Error('eval results have no transcript')
  }
  return { ...base, campaign_id: campaignId, attempt_id: attemptId }
}

interface VerdictInput {
  outcome: Verdict['outcome']
  confidence: number
  stage: Verdict['stage']
  needsReview?: boolean
  at: string
}

function verdict(campaignId: string, attemptId: string, category: string, input: VerdictInput): Verdict {
  return {
    schema_version: '1',
    message_id: attemptId.replace(/^.{8}/, 'dddddddd'),
    campaign_id: campaignId,
    trace_id: 'multi-run',
    attempt_id: attemptId,
    produced_by: 'judge',
    produced_at: input.at,
    target_version: TARGET.version,
    outcome: input.outcome,
    confidence: input.confidence,
    stage: input.stage,
    rubric_version: `${category}@${category.length.toString(16).padStart(8, '0')}`,
    evidence: [{ kind: 'quoted_span', ref: 'turns[0].target_response' }],
    needs_review: input.needsReview ?? false,
  }
}

function plan(campaignId: string, category: string, subcategory: string, owasp: string[]): CampaignPlan {
  return {
    schema_version: '1',
    message_id: campaignId.replace(/^.{8}/, 'eeeeeeee'),
    campaign_id: campaignId,
    trace_id: 'multi-run',
    produced_by: 'orchestrator',
    produced_at: '2026-09-30T06:00:00.000Z',
    category,
    subcategory,
    owasp_llm_ids: owasp.filter((id) => id.startsWith('LLM')),
    owasp_ids: owasp.filter((id) => id.startsWith('A')),
    seed_case_ids: [`${subcategory}-seed`],
    max_attempts: 5,
    max_turns: 2,
    budget: { tokens: 50_000, usd: 1 },
    target_version: TARGET.version,
  }
}

interface AttemptInput {
  id: string
  campaignId: string
  category: string
  subcategory: string
  owasp: string[]
  parent?: string
  verdict: VerdictInput
}

function attempt(input: AttemptInput): RunArtifactAttempt {
  return {
    transcript: transcript(input.campaignId, input.id),
    ...(input.parent ? { parent_attempt_id: input.parent } : {}),
    fingerprint: `fp-${input.id}`,
    category: input.category,
    subcategory: input.subcategory,
    owasp_ids: input.owasp,
    cost_usd: 0.05,
    verdicts: [verdict(input.campaignId, input.id, input.category, input.verdict)],
  }
}

const A = Array.from({ length: 7 }, (_, index) => uuid('a0', index + 1))
const fail = (at: string): VerdictInput => ({ outcome: 'fail', confidence: 0.9, stage: 'llm_primary', at })

const exfil = { campaignId: CAMPAIGNS.exfil, category: 'data_exfiltration', subcategory: 'phi_leakage', owasp: ['LLM02', 'A01'] }
const injection = { campaignId: CAMPAIGNS.injection, category: 'prompt_injection', subcategory: 'direct', owasp: ['LLM01', 'A03'] }
const tools = { campaignId: CAMPAIGNS.tools, category: 'tool_misuse', subcategory: 'parameter_tampering', owasp: ['LLM06', 'A01'] }

const artifact: RunArtifact = {
  schema_version: '1',
  run_key: 'multi-item-run-1',
  trigger: 'cron',
  status: 'completed',
  started_at: '2026-09-30T06:00:00.000Z',
  finished_at: '2026-09-30T07:30:00.000Z',
  target: TARGET,
  spend_usd: 4.2,
  summary: {
    target_version: TARGET.version,
    headline: '7 attempts, 2 new findings, 1 sent to review',
    new_tickets: [],
    regressions: [],
    verified_fixes: [],
    queue: { ran: 3, cut: 1 },
    notes: ['One prompt-injection variant needs review.'],
    trace_url: TRACE_URL,
    generated_at: '2026-09-30T07:31:00.000Z',
  },
  campaigns: [
    {
      plan: plan(CAMPAIGNS.exfil, exfil.category, exfil.subcategory, exfil.owasp),
      spend_usd: 1.6,
      status: 'completed',
      attempts: [
        attempt({ ...exfil, id: A[0] ?? '', verdict: fail('2026-09-30T06:10:00.000Z') }),
        attempt({
          ...exfil,
          id: A[1] ?? '',
          parent: A[0] ?? '',
          verdict: { outcome: 'success', confidence: 1, stage: 'detector', at: '2026-09-30T06:12:00.000Z' },
        }),
      ],
    },
    {
      plan: plan(CAMPAIGNS.injection, injection.category, injection.subcategory, injection.owasp),
      spend_usd: 1.8,
      status: 'completed',
      attempts: [
        attempt({ ...injection, id: A[2] ?? '', verdict: fail('2026-09-30T06:30:00.000Z') }),
        attempt({
          ...injection,
          id: A[3] ?? '',
          verdict: { outcome: 'success', confidence: 0.88, stage: 'llm_primary', at: '2026-09-30T06:32:00.000Z' },
        }),
        attempt({
          ...injection,
          id: A[4] ?? '',
          parent: A[3] ?? '',
          verdict: {
            outcome: 'partial',
            confidence: 0.55,
            stage: 'llm_tiebreak',
            needsReview: true,
            at: '2026-09-30T06:35:00.000Z',
          },
        }),
      ],
    },
    {
      plan: plan(CAMPAIGNS.tools, tools.category, tools.subcategory, tools.owasp),
      spend_usd: 0.8,
      status: 'completed',
      attempts: [
        attempt({ ...tools, id: A[5] ?? '', verdict: fail('2026-09-30T07:00:00.000Z') }),
        attempt({ ...tools, id: A[6] ?? '', verdict: fail('2026-09-30T07:05:00.000Z') }),
      ],
    },
  ],
  exploits: [
    {
      id: 'ignored',
      fingerprint: `fp-${A[1]}`,
      severity: 'critical',
      category: exfil.category,
      subcategory: exfil.subcategory,
      owasp_ids: exfil.owasp,
      min_repro: { turns: ['...'] },
      family_ids: [A[0] ?? '', A[1] ?? ''],
      report: { body: { title: 'Canary PHI returned for another patient' } },
    },
    {
      id: 'ignored',
      fingerprint: `fp-${A[3]}`,
      severity: 'high',
      category: injection.category,
      subcategory: injection.subcategory,
      owasp_ids: injection.owasp,
      min_repro: { turns: ['...'] },
      family_ids: [A[3] ?? '', A[4] ?? ''],
      report: { body: { title: 'Pasted note overrides the system prompt' } },
    },
  ],
  agent_events: [
    { trace_id: 'multi-run', agent: 'orchestrator', event_type: 'plan_created', cost_usd: 0.02, created_at: '2026-09-30T06:00:10.000Z', payload: { summary: 'Planned 3 campaigns', trace_url: TRACE_URL } },
    { trace_id: 'multi-run', agent: 'redteam', event_type: 'attempt_batch', cost_usd: 0.6, created_at: '2026-09-30T06:40:00.000Z' },
    { trace_id: 'multi-run', agent: 'target', event_type: 'calls', cost_usd: 2.4, created_at: '2026-09-30T06:50:00.000Z' },
    { trace_id: 'multi-run', agent: 'judge', event_type: 'verdict_batch', cost_usd: 1.0, created_at: '2026-09-30T07:10:00.000Z' },
    { trace_id: 'multi-run', agent: 'documentation', event_type: 'report_drafted', cost_usd: 0.18, created_at: '2026-09-30T07:25:00.000Z' },
  ],
}

describe.skipIf(!url)('dashboard views over an imported multi-item run', () => {
  let isolated: IsolatedSchema
  let pool: pg.Pool
  let repo: DashboardRepository
  let tickets: { exfil: string; injection: string }

  beforeAll(async () => {
    isolated = await createIsolatedSchema(url ?? '')
    pool = isolated.pool
  }, 60_000)

  afterAll(async () => {
    await isolated?.drop()
  })

  beforeEach(async () => {
    await pool.query(
      `TRUNCATE ground_truth, agent_events, reports, verdicts, exploits, attempts, campaigns, nightly_runs,
                operator_requests, coverage_snapshots, target_versions, targets RESTART IDENTITY CASCADE`,
    )
    const result = await importPlan(pool, planRunImport(artifact))
    expect(result.status).not.toBe('already_imported')
    const ids = await pool.query<{ id: string; category: string }>('SELECT id, category FROM exploits')
    const byCategory = new Map(ids.rows.map((row) => [row.category, row.id]))
    tickets = { exfil: byCategory.get('data_exfiltration') ?? '', injection: byCategory.get('prompt_injection') ?? '' }
    repo = createPgRepository({ pool, config, now: () => NOW })
  })

  it('run history: one completed run with its verdict split, new tickets, spend, and trace', async () => {
    const [run, ...rest] = await repo.listRuns()
    expect(rest).toEqual([])
    expect(run).toMatchObject({
      trigger: 'cron',
      status: 'completed',
      targetVersion: 'copilot@multi',
      attempts: 7,
      verdicts: { success: 2, partial: 1, fail: 4 },
      newTickets: 2,
      spendUsd: 4.2,
      hasMorningReport: true,
      traceUrl: TRACE_URL,
    })
  })

  it('morning report: the real NightlyRunSummary, with the tickets the importer assigned', async () => {
    const [run] = await repo.listRuns()
    const report = await repo.getMorningReport(run?.id ?? '')
    expect(report).toMatchObject({
      headline: '7 attempts, 2 new findings, 1 sent to review',
      attempts: 7,
      verdicts: { success: 2, partial: 1, fail: 4 },
      spendUsd: 4.2,
      regressions: [],
      verifiedFixes: [],
      queue: { ran: 3, cut: 1 },
      notes: ['One prompt-injection variant needs review.'],
      traceUrl: TRACE_URL,
    })
    expect([...(report?.newTickets ?? [])].sort()).toEqual([tickets.exfil, tickets.injection].sort())
    expect(report?.newTickets.every((id) => /^AF-\d{4}-\d{4}$/.test(id))).toBe(true)
  })

  it('findings: both tickets with family, confidence, and latest verdict', async () => {
    expect(await repo.getTicket(tickets.exfil)).toMatchObject({
      severity: 'critical',
      status: 'open',
      owaspIds: ['LLM02', 'A01'],
      familySize: 2,
      confidence: 1,
      lastVerdict: 'success',
      discoveredVersion: 'copilot@multi',
    })
    // The needs_review variant is the family's latest verdict.
    expect(await repo.getTicket(tickets.injection)).toMatchObject({ confidence: 0.88, lastVerdict: 'partial' })
  })

  it('coverage: every tested cell with attempts, confirmed, and variant families', async () => {
    const coverage = await repo.getCoverage()
    expect(coverage.targetVersion).toBe('copilot@multi')
    const cell = (subcategory: string) => coverage.cells.find((entry) => entry.subcategory === subcategory)
    expect(cell('phi_leakage')).toMatchObject({ attempts: 2, confirmed: 1, familiesExercised: 1, owaspIds: ['A01', 'LLM02'] })
    expect(cell('direct')).toMatchObject({ attempts: 3, confirmed: 1, familiesExercised: 1 })
    expect(cell('parameter_tampering')).toMatchObject({ attempts: 2, confirmed: 0, familiesExercised: 0 })
  })

  it('resilience: one M4 point for the version across three per-category rubrics', async () => {
    const layout = buildTrendSeries(await repo.getResilienceTrend())
    expect(layout.points).toEqual([
      expect.objectContaining({ targetVersion: 'copilot@multi', novelAttempts: 7, confirmed: 2, rate: 28.6 }),
    ])
    expect(layout.points[0]?.rubrics).toHaveLength(3)
    expect(layout.rubricChanges).toEqual([])
  })

  it('cost and activity: spend per run and per agent, events newest first with the trace link', async () => {
    const cost = await repo.getCost()
    expect(cost.byRun.map((run) => run.spendUsd)).toEqual([4.2])
    expect(cost.byRole).toEqual([
      { role: 'target', spendUsd: 2.4 },
      { role: 'judge', spendUsd: 1 },
      { role: 'redteam', spendUsd: 0.6 },
      { role: 'documentation', spendUsd: 0.18 },
      { role: 'orchestrator', spendUsd: 0.02 },
    ])
    const events = await repo.listAgentEvents(10)
    expect(events.map((event) => event.agent)).toEqual(['documentation', 'judge', 'target', 'redteam', 'orchestrator'])
    expect(events.at(-1)).toMatchObject({ summary: 'Planned 3 campaigns', traceUrl: TRACE_URL })
  })

  it('needs_review: the flagged variant is linked to its ticket, and a human decision updates ticket, health, and M4', async () => {
    const [item, ...rest] = await repo.listNeedsReview()
    expect(rest).toEqual([])
    expect(item).toMatchObject({ exploitId: tickets.injection, outcome: 'partial', stage: 'llm_tiebreak' })

    await repo.resolveReview(item?.verdictId ?? '', { decision: 'overturn', outcome: 'success' }, 'priya')

    expect(await repo.listNeedsReview()).toEqual([])
    expect(await repo.getTicket(tickets.injection)).toMatchObject({ lastVerdict: 'success', confidence: 1 })
    expect(await repo.getJudgeHealth()).toMatchObject({
      backlog: 0,
      reviewed: 1,
      overturned: 1,
      byCategory: [{ category: 'prompt_injection', reviewed: 1, overturned: 1 }],
      groundTruthLabels: 1,
    })
    expect(buildTrendSeries(await repo.getResilienceTrend()).points[0]).toMatchObject({ confirmed: 3 })
  })

  it('approvals: both drafts wait at G4; approve and reject write reports.status and approved_by', async () => {
    const drafts = await repo.listApprovals()
    expect(drafts.map((draft) => [draft.exploitId, draft.gate, draft.title])).toEqual(
      expect.arrayContaining([
        [tickets.exfil, 'G4', 'Canary PHI returned for another patient'],
        [tickets.injection, 'G4', 'Pasted note overrides the system prompt'],
      ]),
    )
    const byExploit = new Map(drafts.map((draft) => [draft.exploitId, draft.reportId]))
    await repo.decideApproval(byExploit.get(tickets.exfil) ?? '', 'approve', 'priya')
    await repo.decideApproval(byExploit.get(tickets.injection) ?? '', 'reject', 'priya')

    const rows = await pool.query<{ exploit_id: string; status: string; approved_by: string; published_at: Date | null }>(
      'SELECT exploit_id, status, approved_by, published_at FROM reports ORDER BY exploit_id',
    )
    const stored = new Map(rows.rows.map((row) => [row.exploit_id, row]))
    expect(stored.get(tickets.exfil)).toMatchObject({ status: 'published', approved_by: 'priya', published_at: NOW })
    expect(stored.get(tickets.injection)).toMatchObject({ status: 'rejected', approved_by: 'priya', published_at: null })
    expect(await repo.listApprovals()).toEqual([])
  })
})
