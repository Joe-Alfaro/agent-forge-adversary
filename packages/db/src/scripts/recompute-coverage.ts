/**
 * Usage, from the repo root: npm run db:recompute-coverage
 * Needs DATABASE_URL. Rewrites coverage_snapshots for every target version from
 * that database's own attempts and exploits (see src/coverage.ts). It changes
 * nothing else, and running it twice gives the same result.
 */
import pg from 'pg'

import { recomputeCoverage } from '../coverage.js'
import { resolveDbConfig } from '../index.js'

async function main() {
  const pool = new pg.Pool({ connectionString: resolveDbConfig().connectionString })
  try {
    const versions = await pool.query<{ id: number; version: string }>('SELECT id, version FROM target_versions ORDER BY id')
    await versions.rows.reduce(async (previous, row) => {
      await previous
      const cells = await recomputeCoverage(pool, row.id)
      console.log(`${row.version}: ${cells} cells recomputed`)
    }, Promise.resolve())
  } finally {
    await pool.end()
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
