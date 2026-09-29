import type { TaxonomyCell } from '@agentforge/contracts'

import type { CoverageCell } from './models.js'

/*
 * Browser-safe coverage helpers. The taxonomy itself (ATTACK_TAXONOMY,
 * listTaxonomyCells) is imported on the server only: the contracts package
 * entry also loads the Node-only validators.
 */

export function cellKey(cell: { category: string; subcategory: string }): string {
  return `${cell.category}/${cell.subcategory}`
}

/**
 * Exactly the taxonomy's cells, in taxonomy order, with live counts where they
 * exist and zero attempts where they do not, so gaps are visible.
 */
export function mergeCoverage(live: readonly CoverageCell[], taxonomy: readonly TaxonomyCell[]): CoverageCell[] {
  const liveByKey = new Map(live.map((cell) => [cellKey(cell), cell]))
  return taxonomy.map(
    (cell): CoverageCell => liveByKey.get(cellKey(cell)) ?? { ...cell, owaspIds: [], attempts: 0, confirmed: 0 },
  )
}

/** Number of shades in the heatmap's sequential ramp; level 0 means untested. */
export const HEAT_LEVELS = 5

export interface GridCell extends CoverageCell {
  /** 0 when untested, otherwise 1..HEAT_LEVELS relative to the busiest cell. */
  level: number
}

export interface GridRow {
  category: CoverageCell['category']
  cells: GridCell[]
}

/** Groups cells into one row per category, in first-seen order. */
export function coverageGrid(cells: readonly CoverageCell[]): GridRow[] {
  const max = cells.reduce((highest, cell) => Math.max(highest, cell.attempts), 0)
  const rows = cells.reduce<Map<CoverageCell['category'], GridCell[]>>((grouped, cell) => {
    const level = cell.attempts === 0 || max === 0 ? 0 : Math.ceil((cell.attempts / max) * HEAT_LEVELS)
    grouped.set(cell.category, [...(grouped.get(cell.category) ?? []), { ...cell, level }])
    return grouped
  }, new Map())
  return [...rows.entries()].map(([category, rowCells]) => ({ category, cells: rowCells }))
}
