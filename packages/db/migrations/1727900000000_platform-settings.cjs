/*
 * platform_settings: operator-adjustable platform configuration, one row (id 1).
 * nightly_budget_usd is the nightly budget envelope. The dashboard's Tonight's
 * queue control upserts it; plan:preview and the nightly executor read it. No
 * row is seeded: until an operator sets a value, readers fall back to
 * NIGHTLY_BUDGET_USD, then $25.
 */
exports.shorthands = undefined

exports.up = (pgm) => {
  pgm.createTable('platform_settings', {
    id: { type: 'integer', primaryKey: true, default: 1 },
    nightly_budget_usd: { type: 'numeric(10,2)', notNull: true, default: 25 },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_by: { type: 'text' },
  })
  pgm.addConstraint('platform_settings', 'platform_settings_singleton', { check: 'id = 1' })
  pgm.addConstraint('platform_settings', 'platform_settings_budget_nonnegative', { check: 'nightly_budget_usd >= 0' })
}

exports.down = (pgm) => {
  pgm.dropTable('platform_settings')
}
