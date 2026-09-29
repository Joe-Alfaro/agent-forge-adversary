import { coverageGrid, type GridCell, HEAT_LEVELS } from '../lib/coverage.js'
import { formatDateTime, humanize } from '../lib/format.js'
import type { CoverageCell } from '../lib/models.js'

function describeCell(cell: GridCell): string {
  const name = humanize(cell.subcategory)
  if (cell.attempts === 0) {
    return `${name}: untested`
  }
  const lastTested = cell.lastRunAt ? `, last tested ${formatDateTime(cell.lastRunAt)}` : ''
  return `${name}: ${cell.attempts} attempts, ${cell.confirmed} confirmed${lastTested}`
}

function HeatTile({ cell }: { cell: GridCell }) {
  const label = describeCell(cell)
  if (cell.attempts === 0) {
    return (
      <li className="heat-tile heat-untested" aria-label={label} title={label}>
        <span className="heat-name">{humanize(cell.subcategory)}</span>
        <span className="heat-value">Untested</span>
      </li>
    )
  }
  return (
    <li className={`heat-tile heat-${cell.level}`} aria-label={label} title={label}>
      <span className="heat-name">{humanize(cell.subcategory)}</span>
      <span className="heat-value">{cell.attempts}</span>
      {cell.confirmed > 0 && <span className="heat-confirmed">{`${cell.confirmed} confirmed`}</span>}
    </li>
  )
}

export interface CoverageHeatmapProps {
  cells: CoverageCell[]
}

/** Category × subcategory grid: shade is attempt volume, dashed tiles are untested gaps. */
export function CoverageHeatmap({ cells }: CoverageHeatmapProps) {
  const rows = coverageGrid(cells)
  const untested = cells.filter((cell) => cell.attempts === 0).length

  return (
    <figure className="heatmap">
      <figcaption>
        <span>{`${untested} of ${cells.length} cells untested on this version.`}</span>
        <span className="heat-legend" aria-hidden="true">
          Attempts: fewer
          {Array.from({ length: HEAT_LEVELS }, (_, index) => (
            <span key={index} className={`heat-swatch heat-${index + 1}`} />
          ))}
          more
          <span className="heat-swatch heat-untested" /> untested
        </span>
      </figcaption>
      {rows.map((row) => (
        <div key={row.category} className="heat-row" role="group" aria-label={humanize(row.category)}>
          <p className="heat-category">{humanize(row.category)}</p>
          <ul className="heat-cells">
            {row.cells.map((cell) => (
              <HeatTile key={cell.subcategory} cell={cell} />
            ))}
          </ul>
        </div>
      ))}
    </figure>
  )
}
