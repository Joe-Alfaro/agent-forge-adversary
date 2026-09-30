/**
 * The nightly cron worker (pg-boss, ARCHITECTURE 7.0). Long-running: registers
 * the NIGHTLY_CRON schedule (default `0 1 * * *` in NIGHTLY_TZ, default
 * America/Chicago) and, on each firing, polls the target version, runs
 * plan:preview for that window, then executes the scheduled row.
 *
 * Nothing is scheduled unless NIGHTLY_ENABLED=true — otherwise it removes any
 * existing schedule and exits — so starting this worker cannot spend by
 * accident. When enabled, NIGHTLY_SPEND_CAP_USD (hard cap) is required and spend
 * is also bounded by the plan envelope (NIGHTLY_BUDGET_USD).
 *
 * Usage (after `npm run build`):
 *   NIGHTLY_ENABLED=true NIGHTLY_SPEND_CAP_USD=5 NIGHTLY_BUDGET_USD=5 \
 *   DATABASE_URL=postgres://… npm run nightly:worker -w apps/worker
 */
import pg from 'pg'
import { PgBoss } from 'pg-boss'

import {
  PgOrchestratorRepository,
  previewNightlyPlan,
  readNightlyCronConfig,
  readPlanPreviewConfig,
  registerNightlyCron,
  runNightlyJob,
  runScheduledNightly,
} from '../orchestrator/index.js'
import { liveDeps, requirePositiveUsd } from './liveDeps.js'
import { loadAgentforgeEnv } from './loadEnv.js'
import { printRunResult } from './runReport.js'

async function main(): Promise<void> {
  const envFile = loadAgentforgeEnv()
  console.log(envFile === null ? 'No AgentForge env file found.' : `Loaded env from ${envFile}`)
  const databaseUrl = (process.env.DATABASE_URL ?? '').trim()
  if (databaseUrl === '') throw new Error('DATABASE_URL is not set.')
  const cron = readNightlyCronConfig(process.env)

  const boss = new PgBoss({ connectionString: databaseUrl, max: 2 })
  boss.on('error', (error: unknown) => console.error('pg-boss:', error instanceof Error ? error.message : error))

  if (!cron.enabled) {
    await boss.start()
    await registerNightlyCron(boss, cron, async () => {})
    console.log('NIGHTLY_ENABLED is not "true": nightly schedule removed; nothing will run.')
    await boss.stop()
    return
  }

  // Validate every setting and secret before connecting, so a misconfiguration exits instead of hanging.
  const spendCapUsd = requirePositiveUsd(process.env, 'NIGHTLY_SPEND_CAP_USD')
  const previewConfig = readPlanPreviewConfig(process.env)
  const deps = liveDeps(process.env)
  await boss.start()
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 4 })
  const repo = new PgOrchestratorRepository(pool)

  const handler = async () => {
    const { result } = await runNightlyJob({
      now: () => new Date(),
      pollTargetVersion: () => deps.adapter.getVersion(),
      recordTargetVersion: async (version) => {
        await repo.ensureTargetVersion(deps.copilotBase, version)
      },
      preview: ({ targetVersion, scheduledFor }) =>
        previewNightlyPlan({
          pool,
          seeds: deps.suite,
          config: { ...previewConfig, ...(targetVersion ? { targetVersion } : {}) },
          now: new Date(),
          scheduledFor,
        }),
      execute: (claimId) => runScheduledNightly({ ...deps, repo, spendCapUsd, targetBaseUrl: deps.copilotBase, claimId }),
      log: (message) => console.log(`[nightly] ${message}`),
    })
    if (result !== null) printRunResult(result, spendCapUsd)
    await deps.tracer.flush().catch(() => {})
  }

  await registerNightlyCron(boss, cron, handler)
  console.log(`Nightly scheduled: "${cron.cron}" ${cron.timeZone}; envelope $${previewConfig.budgetUsd}, hard cap $${spendCapUsd}.`)

  const shutdown = async () => {
    await boss.stop().catch(() => {})
    await deps.tracer.shutdown().catch(() => {})
    await pool.end().catch(() => {})
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch((error: unknown) => {
  console.error('nightly-worker failed:', error instanceof Error ? error.message : error)
  process.exitCode = 1
})
