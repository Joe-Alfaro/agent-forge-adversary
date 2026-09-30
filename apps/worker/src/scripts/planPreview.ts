/**
 * "Plan preview": the Orchestrator's DRY-RUN nightly planner (ARCHITECTURE 7.0,
 * 7.2). It reads tonight's queue, owed regressions, and the coverage matrix from
 * the Postgres in DATABASE_URL, builds tonight's NightlyPlan v1, and upserts it
 * into the ONE scheduled cron nightly_runs row the dashboard's Tonight's queue
 * reads. NO attacks, NO model calls, NO spend; operator_requests are not drained.
 * Re-running refreshes the same row.
 *
 * Usage (after `npm run build`):
 *   DATABASE_URL=postgres://localhost/agentforge npm run plan:preview -w apps/worker
 *
 * Envelope: platform_settings.nightly_budget_usd (set in the dashboard), else
 * NIGHTLY_BUDGET_USD, else 25. Env knobs: NIGHTLY_HOUR / NIGHTLY_TZ (default
 * 01:00 America/Chicago), PLAN_TOP_K, PLAN_MAX_ATTEMPTS,
 * PLAN_COST_PER_ATTEMPT_USD, PLAN_TARGET_VERSION.
 */
import pg from 'pg'

import { loadEvalSuite } from '../evals/index.js'
import { previewNightlyPlan, readPlanPreviewConfig } from '../orchestrator/index.js'
import { loadAgentforgeEnv } from './loadEnv.js'
import { seedDir } from './paths.js'

async function main(): Promise<void> {
  const envFile = loadAgentforgeEnv()
  console.log(envFile === null ? 'No AgentForge env file found.' : `Loaded env from ${envFile}`)
  const databaseUrl = (process.env.DATABASE_URL ?? '').trim()
  if (databaseUrl === '') {
    throw new Error('DATABASE_URL is not set.')
  }

  const config = readPlanPreviewConfig(process.env)
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 2 })
  try {
    const result = await previewNightlyPlan({ pool, seeds: loadEvalSuite(seedDir()), config, now: new Date() })
    const { plan } = result
    console.log(`\n=== Plan preview (dry run: nothing executed, $0 spent) ===`)
    console.log(`nightly_runs.id ${result.nightlyRunId} (${result.created ? 'created' : 'refreshed'}), trigger=cron status=scheduled`)
    console.log(`scheduled_for: ${result.scheduledFor}  target: ${plan.target_version}`)
    console.log(`envelope $${plan.budget_usd}; est $${plan.estimated_cost_usd.toFixed(3)}; ${plan.run_count} run / ${plan.cut_count} cut`)
    plan.items.forEach((item, index) => {
      const cell = item.subcategory ? `${item.category}/${item.subcategory}` : item.category
      const priority = item.priority === undefined ? '' : ` p=${item.priority.toFixed(3)}`
      const owasp = item.owasp_ids ? ` [${item.owasp_ids.join(',')}]` : ''
      console.log(`${String(index + 1).padStart(2)}. ${item.decision.padEnd(3)} ${item.kind.padEnd(17)} ${cell}${owasp}${priority} $${item.estimated_cost_usd.toFixed(2)} — ${item.reason}`)
    })
    ;(plan.notes ?? []).forEach((note) => console.log(`note: ${note}`))
  } finally {
    await pool.end()
  }
}

main().catch((error: unknown) => {
  console.error('plan-preview failed:', error instanceof Error ? error.message : error)
  process.exitCode = 1
})
