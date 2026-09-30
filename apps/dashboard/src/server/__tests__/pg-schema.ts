import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'

// node-pg-migrate is declared by packages/db and hoisted to the workspace root.
import { runner } from 'node-pg-migrate'
import pg from 'pg'

const migrationsDir = fileURLToPath(new URL('../../../../../packages/db/migrations', import.meta.url))

export interface IsolatedSchema {
  pool: pg.Pool
  schema: string
  drop: () => Promise<void>
}

/**
 * Migrates a fresh `af_test_*` schema with packages/db's migrations and returns
 * a pool pinned to it (as packages/db's suites do), so this suite never touches
 * `public` or another suite's tables even when every suite shares one database.
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
    // The global migration lock would make parallel suites wait on each other; each suite owns its schema.
    noLock: true,
    log: () => {},
  })
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 4, options: `-c search_path=${schema}` })
  return {
    pool,
    schema,
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
