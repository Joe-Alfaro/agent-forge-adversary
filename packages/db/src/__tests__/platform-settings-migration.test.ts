import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'

import { runner } from 'node-pg-migrate'
import pg from 'pg'
import { afterAll, describe, expect, it } from 'vitest'

const migrationsDir = fileURLToPath(new URL('../../migrations', import.meta.url))
const testDbUrl = process.env.DB_TEST_DATABASE_URL

/*
 * platform_settings: the operator-adjustable singleton (nightly budget). Runs the
 * migrations up, down one step, and up again in an isolated schema.
 */
describe.skipIf(!testDbUrl)('platform_settings migration', () => {
  const schema = `af_test_${randomUUID().replaceAll('-', '').slice(0, 16)}`
  const migrate = (direction: 'up' | 'down', count?: number) =>
    runner({
      databaseUrl: testDbUrl!,
      dir: migrationsDir,
      direction,
      ...(count === undefined ? {} : { count }),
      migrationsTable: 'pgmigrations',
      schema,
      createSchema: true,
      noLock: true,
      log: () => {},
    })
  const pool = new pg.Pool({ connectionString: testDbUrl, options: `-c search_path=${schema}` })
  const exists = async () =>
    (await pool.query(`SELECT to_regclass('platform_settings') IS NOT NULL AS present`)).rows[0]?.present as boolean

  afterAll(async () => {
    await pool.end()
    const admin = new pg.Client({ connectionString: testDbUrl })
    await admin.connect()
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
    await admin.end()
  })

  it('creates a single-row table with no seeded row, and reverses cleanly', async () => {
    await migrate('up')
    expect(await exists()).toBe(true)
    // No row until an operator sets one, so NIGHTLY_BUDGET_USD stays the fallback.
    expect((await pool.query('SELECT count(*)::int AS n FROM platform_settings')).rows[0]?.n).toBe(0)

    // The dashboard's upsert (agentforge-8), verbatim.
    await pool.query(
      `INSERT INTO platform_settings (id, nightly_budget_usd, updated_at, updated_by) VALUES (1, $1, now(), $2)
       ON CONFLICT (id) DO UPDATE
         SET nightly_budget_usd = EXCLUDED.nightly_budget_usd, updated_at = now(), updated_by = EXCLUDED.updated_by`,
      [2, 'priya'],
    )
    const row = (await pool.query('SELECT id, nightly_budget_usd, updated_at, updated_by FROM platform_settings')).rows[0]
    expect(row).toMatchObject({ id: 1, nightly_budget_usd: '2.00', updated_by: 'priya' })
    expect(row?.updated_at).toBeInstanceOf(Date)
    // Defaults: id 1, $25.
    await pool.query('DELETE FROM platform_settings')
    await pool.query('INSERT INTO platform_settings DEFAULT VALUES')
    expect((await pool.query('SELECT id, nightly_budget_usd FROM platform_settings')).rows[0]).toEqual({ id: 1, nightly_budget_usd: '25.00' })

    // Singleton and sign constraints.
    await expect(pool.query('INSERT INTO platform_settings (id) VALUES (2)')).rejects.toThrow(/platform_settings_singleton/)
    // Same range the dashboard validates: more than $0, at most $1000, cents.
    await expect(pool.query('UPDATE platform_settings SET nightly_budget_usd = 0')).rejects.toThrow(/platform_settings_budget_range/)
    await expect(pool.query('UPDATE platform_settings SET nightly_budget_usd = -1')).rejects.toThrow(/platform_settings_budget_range/)
    await expect(pool.query('UPDATE platform_settings SET nightly_budget_usd = 1000.01')).rejects.toThrow(/platform_settings_budget_range/)
    await pool.query('UPDATE platform_settings SET nightly_budget_usd = 1000')
    await pool.query('UPDATE platform_settings SET nightly_budget_usd = 2.345')
    expect((await pool.query('SELECT nightly_budget_usd FROM platform_settings')).rows[0]?.nightly_budget_usd).toBe('2.35')

    await migrate('down', 1)
    expect(await exists()).toBe(false)
    await migrate('up')
    expect(await exists()).toBe(true)
  })
})
