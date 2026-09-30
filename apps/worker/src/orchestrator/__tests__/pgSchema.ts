import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'

import { runner } from 'node-pg-migrate'
import pg from 'pg'

const migrationsDir = fileURLToPath(new URL('../../../../../packages/db/migrations', import.meta.url))

export interface MigratedSchema {
  name: string
  pool: pg.Pool
  drop(): Promise<void>
}

/**
 * Migrates a fresh, uniquely named schema (never `public`) and returns a pool
 * pinned to it, so a gated PG suite is safe alongside others on one database.
 */
export async function createMigratedSchema(databaseUrl: string): Promise<MigratedSchema> {
  const name = `af_test_${randomUUID().replaceAll('-', '').slice(0, 16)}`
  await runner({
    databaseUrl,
    dir: migrationsDir,
    direction: 'up',
    migrationsTable: 'pgmigrations',
    schema: name,
    createSchema: true,
    noLock: true,
    log: () => {},
  })
  const pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${name}`, max: 6 })
  return {
    name,
    pool,
    async drop() {
      await pool.end()
      const admin = new pg.Client({ connectionString: databaseUrl })
      await admin.connect()
      try {
        await admin.query(`DROP SCHEMA IF EXISTS ${name} CASCADE`)
        await admin.query(`DROP SCHEMA IF EXISTS ${name}_boss CASCADE`)
      } finally {
        await admin.end()
      }
    },
  }
}
