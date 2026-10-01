import type pg from 'pg'

/**
 * Rewrites coverage_snapshots for one target version from the attempts and
 * exploits in THIS database. Importers call it instead of trusting an
 * artifact's coverage rows, which were counted in the emitter's own database.
 * The rules match the dashboard's live coverage: attempts and last run per
 * cell, confirmed = the cell's exploits that are not false positives, and
 * families exercised = distinct lineage roots among the cell's variant attempts.
 */
export async function recomputeCoverage(client: pg.Pool | pg.PoolClient, targetVersionId: number): Promise<number> {
  const result = await client.query(
    `WITH RECURSIVE lineage AS (
       SELECT id, id AS root FROM attempts WHERE parent_attempt_id IS NULL
       UNION ALL
       SELECT a.id, l.root FROM attempts a JOIN lineage l ON a.parent_attempt_id = l.id
     ), cells AS (
       SELECT a.category, COALESCE(a.subcategory, '') AS subcategory,
              count(*)::int AS attempts,
              max(a.created_at) AS last_run_at,
              (count(DISTINCT l.root) FILTER (WHERE a.parent_attempt_id IS NOT NULL))::int AS families_exercised
       FROM attempts a
       LEFT JOIN lineage l ON l.id = a.id
       WHERE a.target_version_id = $1
       GROUP BY a.category, COALESCE(a.subcategory, '')
     )
     INSERT INTO coverage_snapshots (target_version_id, category, subcategory, attempts, confirmed, last_run_at, families_exercised)
     SELECT $1, c.category, c.subcategory, c.attempts,
            (SELECT count(*)::int FROM exploits e
             WHERE e.category = c.category AND COALESCE(e.subcategory, '') = c.subcategory AND e.status <> 'false_positive'),
            c.last_run_at, c.families_exercised
     FROM cells c
     ON CONFLICT (target_version_id, category, subcategory) DO UPDATE
       SET attempts = EXCLUDED.attempts, confirmed = EXCLUDED.confirmed,
           last_run_at = EXCLUDED.last_run_at, families_exercised = EXCLUDED.families_exercised`,
    [targetVersionId],
  )
  return result.rowCount ?? 0
}
