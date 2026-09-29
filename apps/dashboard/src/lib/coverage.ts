import type { CoverageCell } from './models.js'

export interface TaxonomyCell {
  category: string
  subcategory: string
}

export type Taxonomy = Readonly<Record<string, readonly string[]>>

function cellKey(cell: TaxonomyCell): string {
  return `${cell.category}\u0000${cell.subcategory}`
}

/** Flattens a taxonomy into cells, keeping its category and subcategory order. */
export function taxonomyCells(taxonomy: Taxonomy): TaxonomyCell[] {
  return Object.entries(taxonomy).flatMap(([category, subcategories]) =>
    subcategories.map((subcategory) => ({ category, subcategory })),
  )
}

/**
 * Every taxonomy cell, in taxonomy order, with live counts where they exist and
 * zero attempts where they do not, so gaps are visible. Cells the data has but
 * the taxonomy does not (old keys, experiments) follow, sorted.
 */
export function mergeCoverage(live: readonly CoverageCell[], taxonomy: readonly TaxonomyCell[]): CoverageCell[] {
  const liveByKey = new Map(live.map((cell) => [cellKey(cell), cell]))
  const planned = taxonomy.map(
    (cell): CoverageCell => liveByKey.get(cellKey(cell)) ?? { ...cell, owaspIds: [], attempts: 0, confirmed: 0 },
  )
  const plannedKeys = new Set(taxonomy.map(cellKey))
  const extra = live
    .filter((cell) => !plannedKeys.has(cellKey(cell)))
    .sort((a, b) => a.category.localeCompare(b.category) || a.subcategory.localeCompare(b.subcategory))
  return [...planned, ...extra]
}

/** Number of shades in the heatmap's sequential ramp; level 0 means untested. */
export const HEAT_LEVELS = 5

export interface GridCell extends CoverageCell {
  /** 0 when untested, otherwise 1..HEAT_LEVELS relative to the busiest cell. */
  level: number
}

export interface GridRow {
  category: string
  cells: GridCell[]
}

/** Groups cells into one row per category, in first-seen order. */
export function coverageGrid(cells: readonly CoverageCell[]): GridRow[] {
  const max = cells.reduce((highest, cell) => Math.max(highest, cell.attempts), 0)
  const rows = cells.reduce<Map<string, GridCell[]>>((grouped, cell) => {
    const level = cell.attempts === 0 || max === 0 ? 0 : Math.ceil((cell.attempts / max) * HEAT_LEVELS)
    grouped.set(cell.category, [...(grouped.get(cell.category) ?? []), { ...cell, level }])
    return grouped
  }, new Map())
  return [...rows.entries()].map(([category, rowCells]) => ({ category, cells: rowCells }))
}
