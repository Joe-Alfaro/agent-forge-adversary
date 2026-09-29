/*
 * coverage_snapshots.families_exercised: the count of distinct variant families
 * (root attempts) exercised for a cell on the current target version. KEY_METRICS
 * M5 and ARCHITECTURE §7.5 require "at least one variant family exercised" per
 * cell for it to count as sufficiently covered, so the coverage matrix needs to
 * store that count, not just attempts/confirmed.
 *
 * The nightly coverage_snapshots writer (Orchestrator) fills this with the number
 * of distinct families per cell, and asserts isTaxonomyCell before insert.
 */
exports.shorthands = undefined

exports.up = (pgm) => {
  pgm.addColumn('coverage_snapshots', {
    families_exercised: { type: 'integer', notNull: true, default: 0 },
  })
}

exports.down = (pgm) => {
  pgm.dropColumn('coverage_snapshots', 'families_exercised')
}
