// @vitest-environment node
import type pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { TonightPlanner } from '../planner.js'
import { createPgRepository } from '../pg-repository.js'
import { resetDatabase, seedQueue, seedTickets } from './pg-seed.js'
import { contractNow, contractQueue, contractRunDate, contractTickets } from './repository-contract.js'
import { createIsolatedSchema, type IsolatedSchema } from './pg-schema.js'

/*
 * "Plan tonight now" through agentforge-10's real planner
 * (@agentforge/planner) in a throwaway schema. Needs packages/planner built
 * (its dist) and DASHBOARD_TEST_DATABASE_URL.
 */
const url = process.env.DASHBOARD_TEST_DATABASE_URL
const config = { envelopeUsd: 25, timeZone: 'America/Chicago', runHour: 1 }

describe.skipIf(!url)('Plan tonight now with the Orchestrator’s planner', () => {
  let isolated: IsolatedSchema
  let pool: pg.Pool
  let planner: TonightPlanner

  beforeAll(async () => {
    // Imported here, not at the top, so a skipped run never needs packages/planner's dist.
    const { createOrchestratorPlanner } = await import('../orchestrator-planner.js')
    isolated = await createIsolatedSchema(url ?? '')
    planner = createOrchestratorPlanner(isolated.pool, { NIGHTLY_BUDGET_USD: '25' })
    pool = isolated.pool
    const versions = await resetDatabase(pool, ['copilot@9.0.0'])
    await seedTickets(pool, contractTickets, versions)
    await seedQueue(pool, contractQueue, contractRunDate)
  }, 60_000)

  afterAll(async () => {
    await isolated?.drop()
  })

  function repository() {
    return createPgRepository({ pool, config, now: () => contractNow, planner })
  }

  it('writes tonight’s scheduled plan and the queue shows it, without draining operator requests', async () => {
    const repo = repository()
    const queue = await repo.planTonight('operator')
    expect(queue.plan?.targetVersion).toBe('copilot@9.0.0')
    const campaigns = queue.plan?.items.filter((item) => item.kind === 'coverage_campaign') ?? []
    expect(campaigns.length).toBeGreaterThan(0)
    expect(campaigns.every((item) => item.owaspIds.length > 0)).toBe(true)
    const requests = await pool.query(`SELECT count(*)::int AS queued FROM operator_requests WHERE status = 'queued'`)
    expect(requests.rows[0]?.queued).toBe(contractQueue.length)
  })

  it('refreshes the one standing scheduled row instead of adding another', async () => {
    const repo = repository()
    await repo.planTonight('operator')
    await repo.planTonight('operator')
    const rows = await pool.query(`SELECT count(*)::int AS n FROM nightly_runs WHERE trigger = 'cron' AND status = 'scheduled'`)
    expect(rows.rows[0]?.n).toBe(1)
  })
})
