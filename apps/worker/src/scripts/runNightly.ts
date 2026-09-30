/**
 * Manual scheduled-run consumer: claims the scheduled cron nightly_runs row that
 * plan:preview wrote (the one the dashboard's Tonight's queue shows) and
 * executes its NightlyPlan in order against the DEPLOYED Co-Pilot — operator
 * reruns, regressions, coverage campaigns — writing to DATABASE_URL. Spend is
 * capped at the lowest of the plan's envelope, the current envelope
 * (platform_settings, else NIGHTLY_BUDGET_USD, else $25), and RUN_SPEND_CAP_USD
 * (required).
 * Also writes an importable RunArtifact.
 *
 * THIS SPENDS. Usage (after `npm run build`):
 *   RUN_SPEND_CAP_USD=3 DATABASE_URL=postgres://… npm run run:nightly -w apps/worker
 * Optional: RUN_NIGHTLY_ID (claim a specific row), RUN_PER_FAMILY.
 */
import pg from 'pg'

import { PgOrchestratorRepository, readPlanPreviewConfig, runScheduledNightly } from '../orchestrator/index.js'
import { liveDeps, requirePositiveUsd } from './liveDeps.js'
import { loadAgentforgeEnv } from './loadEnv.js'
import { printRunResult } from './runReport.js'

async function main(): Promise<void> {
  const envFile = loadAgentforgeEnv()
  console.log(envFile === null ? 'No AgentForge env file found.' : `Loaded env from ${envFile}`)
  const spendCapUsd = requirePositiveUsd(process.env, 'RUN_SPEND_CAP_USD')
  const databaseUrl = (process.env.DATABASE_URL ?? '').trim()
  if (databaseUrl === '') throw new Error('DATABASE_URL is not set.')
  const claimId = process.env.RUN_NIGHTLY_ID ? Number(process.env.RUN_NIGHTLY_ID) : undefined

  const deps = liveDeps(process.env)
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 4 })
  try {
    const result = await runScheduledNightly({
      ...deps,
      repo: new PgOrchestratorRepository(pool),
      spendCapUsd,
      fallbackBudgetUsd: readPlanPreviewConfig(process.env).budgetUsd,
      targetBaseUrl: deps.copilotBase,
      ...(claimId === undefined ? {} : { claimId }),
    })
    if (result === null) {
      console.log('No scheduled cron nightly_runs row to consume (run plan:preview first).')
      return
    }
    printRunResult(result, spendCapUsd)
  } finally {
    await deps.tracer.flush().catch(() => {})
    await deps.tracer.shutdown().catch(() => {})
    await pool.end()
  }
}

main().catch((error: unknown) => {
  console.error('run-nightly failed:', error instanceof Error ? error.message : error)
  process.exitCode = 1
})
