/**
 * Usage, from the repo root: npm run db:import-eval -- evals/results/<file>.json
 * Needs DATABASE_URL. Reads the OWASP mapping from evals/seeds. Safe to re-run.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import pg from 'pg'

import { planEvalImport, type EvalResultsFile, type SeedCase } from '../eval-import.js'
import { importPlan } from '../import-writer.js'
import { resolveDbConfig } from '../index.js'

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T
}

async function main() {
  const source = process.argv[2]
  if (!source) {
    throw new Error('Usage: npm run db:import-eval -- evals/results/<file>.json')
  }
  const seedDir = join('evals', 'seeds')
  const seeds = readdirSync(seedDir)
    .filter((name) => name.endsWith('.json'))
    .flatMap((name) => readJson<SeedCase[]>(join(seedDir, name)))
  const plan = planEvalImport(readJson<EvalResultsFile>(source), seeds, source)

  const pool = new pg.Pool({ connectionString: resolveDbConfig().connectionString })
  try {
    const result = await importPlan(pool, plan)
    console.log(`${result.status}: ${source} as nightly run ${result.runId} (${plan.attempts.length} attempts)`)
  } finally {
    await pool.end()
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
