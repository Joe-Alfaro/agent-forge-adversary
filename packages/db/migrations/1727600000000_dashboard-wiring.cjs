/*
 * Dashboard wiring: queue ordering, cost estimates, coverage + regression
 * tables, and a status CHECK on nightly_runs. Requested by the dashboard worker
 * (agentforge-2) to move the Operator Dashboard onto real data. See
 * ARCHITECTURE.md §14.3.
 *
 * Note: operator_requests.status is already the `request_status` enum
 * (queued|ran|cut|cancelled) from the core migration, so it needs no further
 * constraint here — only nightly_runs.status (plain text) is constrained below.
 */
exports.shorthands = undefined

exports.up = (pgm) => {
  // (1) Queue ordering. `position` is nullable because chat-inserted rows may
  // leave it unset; the drain orders by `position NULLS LAST, created_at`.
  pgm.addColumns('operator_requests', {
    position: { type: 'integer' },
    // (2) Estimated cost shown in "tonight's queue".
    estimated_cost_usd: { type: 'numeric(10,4)' },
  })
  // Replace the (status, requested_for) index with one that also covers the
  // ordering column, so the drain query can filter and order from the index.
  pgm.dropIndex('operator_requests', ['status', 'requested_for'])
  pgm.createIndex('operator_requests', ['status', 'requested_for', 'position'])

  // (3) Coverage matrix, materialised nightly, keyed by cell and version.
  pgm.createTable('coverage_snapshots', {
    target_version_id: {
      type: 'integer',
      notNull: true,
      references: 'target_versions',
      onDelete: 'CASCADE',
    },
    category: { type: 'text', notNull: true },
    subcategory: { type: 'text', notNull: true },
    attempts: { type: 'integer', notNull: true, default: 0 },
    confirmed: { type: 'integer', notNull: true, default: 0 },
    last_run_at: { type: 'timestamptz' },
  })
  pgm.addConstraint('coverage_snapshots', 'coverage_snapshots_pkey', {
    primaryKey: ['target_version_id', 'category', 'subcategory'],
  })

  // (4) Regression harness output.
  pgm.createTable('regression_runs', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    target_version_id: {
      type: 'integer',
      notNull: true,
      references: 'target_versions',
      onDelete: 'CASCADE',
    },
    scope: { type: 'text', notNull: true, default: 'full' },
    status: { type: 'text', notNull: true, default: 'running' },
    started_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    finished_at: { type: 'timestamptz' },
  })
  pgm.createTable('regression_results', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    run_id: { type: 'uuid', notNull: true, references: 'regression_runs', onDelete: 'CASCADE' },
    exploit_id: { type: 'text', notNull: true, references: 'exploits', onDelete: 'CASCADE' },
    outcome: { type: 'text', notNull: true },
    replay_count: { type: 'integer', notNull: true, default: 0 },
    majority: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  })
  pgm.createIndex('regression_results', 'run_id')
  pgm.createIndex('regression_results', 'exploit_id')

  // (6) Constrain nightly_runs.status (plain text in the core migration).
  pgm.addConstraint('nightly_runs', 'nightly_runs_status_check', {
    check: "status IN ('scheduled', 'running', 'completed', 'failed', 'aborted')",
  })
}

exports.down = (pgm) => {
  pgm.dropConstraint('nightly_runs', 'nightly_runs_status_check')

  pgm.dropTable('regression_results')
  pgm.dropTable('regression_runs')
  pgm.dropTable('coverage_snapshots')

  pgm.dropIndex('operator_requests', ['status', 'requested_for', 'position'])
  pgm.createIndex('operator_requests', ['status', 'requested_for'])
  pgm.dropColumns('operator_requests', ['position', 'estimated_cost_usd'])
}
