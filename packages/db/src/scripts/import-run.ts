/**
 * Usage, from the repo root: npm run db:import-run -- <run-artifact>.json
 * Pass `-` to read the artifact from stdin (e.g. piped through `railway ssh`).
 * Needs DATABASE_URL. Validates the artifact (see src/run-import.ts) and writes
 * it in one transaction. Safe to re-run: the same run_key imports once.
 */
import { readFileSync } from 'node:fs'

import pg from 'pg'

import { importPlan } from '../import-writer.js'
import { resolveDbConfig } from '../index.js'
import { planRunImport, type RunArtifact } from '../run-import.js'

async function main() {
  const source = process.argv[2]
  if (!source) {
    throw new Error('Usage: npm run db:import-run -- <run-artifact>.json')
  }
  // fd 0 is stdin.
  const plan = planRunImport(JSON.parse(readFileSync(source === '-' ? 0 : source, 'utf8')) as RunArtifact)

  const pool = new pg.Pool({ connectionString: resolveDbConfig().connectionString })
  try {
    const result = await importPlan(pool, plan)
    console.log(
      `${result.status}: ${source} as nightly run ${result.runId} ` +
        `(${plan.campaigns.length} campaigns, ${plan.attempts.length} attempts, ${plan.exploits.length} exploits)`,
    )
  } finally {
    await pool.end()
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
