import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'

import { runner } from 'node-pg-migrate'
import pg from 'pg'

const migrationsDir = fileURLToPath(new URL('../../migrations', import.meta.url))

export interface IsolatedSchema {
  pool: pg.Pool
  drop: () => Promise<void>
}

/**
 * Migrates a fresh, uniquely named schema and returns a pool pinned to it, so
 * a suite never touches `public` or another suite's tables, even when every
 * suite shares one database.
 */
export async function createIsolatedSchema(databaseUrl: string): Promise<IsolatedSchema> {
  const schema = `af_test_${randomUUID().replaceAll('-', '').slice(0, 16)}`
  await runner({
    databaseUrl,
    dir: migrationsDir,
    direction: 'up',
    migrationsTable: 'pgmigrations',
    schema,
    createSchema: true,
    // The global migration lock would make parallel suites fail; each suite owns its schema.
    noLock: true,
    log: () => {},
  })
  const pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` })
  return {
    pool,
    async drop() {
      await pool.end()
      const admin = new pg.Client({ connectionString: databaseUrl })
      await admin.connect()
      try {
        await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
      } finally {
        await admin.end()
      }
    },
  }
}
