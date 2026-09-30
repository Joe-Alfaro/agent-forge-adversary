import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { validateNightlyRunSummary } from '@agentforge/contracts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createIsolatedSchema, type IsolatedSchema } from './isolated-schema.js'

import { planEvalImport, type EvalResultsFile, type SeedCase } from '../eval-import.js'
import { importPlan } from '../import-writer.js'

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url))
const RESULTS_FILE = 'evals/results/2026-09-29-copilot-c1f011e.json'

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(`${repoRoot}${path}`, 'utf8')) as T
}

const results = readJson<EvalResultsFile>(RESULTS_FILE)
const seeds = [
  'data_exfiltration', 'denial_of_service', 'identity_role_exploitation', 'misinformation',
  'prompt_injection', 'state_corruption', 'tool_misuse',
].flatMap((category) => readJson<SeedCase[]>(`evals/seeds/${category}.json`))

describe('planEvalImport', () => {
  const plan = planEvalImport(results, seeds, RESULTS_FILE)

  it('keys the run on the results file so a re-import is detectable', () => {
    expect(plan.importKey).toBe(`eval-import:${RESULTS_FILE}`)
    expect(plan.run.trigger).toBe('run_now')
    expect(plan.run.status).toBe('completed')
    expect(plan.run.spendUsd).toBe(results.spend_estimate_usd.total)
  })

  it('writes a morning report that satisfies NightlyRunSummary v1 and reports only what happened', () => {
    expect(validateNightlyRunSummary(plan.run.summary).errors).toEqual([])
    expect(plan.run.summary.new_tickets).toEqual([])
    expect(plan.run.summary.target_version).toBe('copilot@c1f011e')
    expect(plan.run.summary.trace_url).toBe(results.trace_url)
    expect(plan.run.summary.headline).toContain('0 confirmed')
  })

  it('maps each case to one campaign, attempt, verdict, and judge cost event', () => {
    expect(plan.attempts).toHaveLength(results.cases.length)
    const dx = plan.attempts.find((attempt) => attempt.fingerprint === 'seed:dx-001')
    expect(dx).toMatchObject({
      category: 'data_exfiltration',
      subcategory: 'phi_leakage',
      owaspIds: ['LLM02', 'A01'],
      verdicts: [{ outcome: 'fail', confidence: 0.9, stage: 'llm_primary', needsReview: false }],
    })
    expect(plan.events.every((event) => event.agent === 'judge')).toBe(true)
    const judgeSpend = plan.events.reduce((sum, event) => sum + event.costUsd, 0)
    expect(judgeSpend).toBeCloseTo(results.spend_estimate_usd.judge, 6)
  })

  it('refuses a case whose seed is unknown instead of guessing its OWASP mapping', () => {
    expect(() => planEvalImport(results, seeds.filter((seed) => seed.id !== 'dx-001'), RESULTS_FILE)).toThrow('dx-001')
  })
})

// Needs a Postgres it may create schemas in. Each run migrates its own throwaway
// schema and drops it afterwards, so it never touches `public` or other suites.
const testDbUrl = process.env.DB_TEST_DATABASE_URL

describe.skipIf(!testDbUrl)('importEvalResults (Postgres)', () => {
  let isolated: IsolatedSchema
  let pool: IsolatedSchema['pool']

  beforeAll(async () => {
    isolated = await createIsolatedSchema(testDbUrl!)
    pool = isolated.pool
  })

  afterAll(() => isolated?.drop())

  it('imports once and is a no-op the second time', async () => {
    const plan = planEvalImport(results, seeds, RESULTS_FILE)
    const first = await importPlan(pool, plan)
    const second = await importPlan(pool, plan)
    expect(first.status).toBe('imported')
    expect(second).toEqual({ status: 'already_imported', runId: first.runId })

    const counts = await pool.query(`
      SELECT (SELECT count(*) FROM nightly_runs)::int AS runs,
             (SELECT count(*) FROM attempts)::int AS attempts,
             (SELECT count(*) FROM verdicts)::int AS verdicts,
             (SELECT count(*) FROM agent_events WHERE agent = 'judge')::int AS events,
             (SELECT count(*) FROM campaigns WHERE nightly_run_id = $1)::int AS campaigns`, [first.runId])
    expect(counts.rows[0]).toEqual({ runs: 1, attempts: 7, verdicts: 7, events: 7, campaigns: 7 })
  })
})
