import { cellKey, coverageGrid, type GridCell, HEAT_LEVELS } from '../lib/coverage.js'
import { formatDateTime, humanize } from '../lib/format.js'
import type { CoverageCell, M5Summary } from '../lib/models.js'

type RiskStatus = 'none' | 'covered' | 'uncovered'

function describeCell(cell: GridCell, risk: RiskStatus): string {
  const name = humanize(cell.subcategory)
  const lastTested = cell.lastRunAt ? `, last tested ${formatDateTime(cell.lastRunAt)}` : ''
  const summary = cell.attempts === 0 ? `${name}: untested` : `${name}: ${cell.attempts} attempts, ${cell.confirmed} confirmed${lastTested}`
  if (risk === 'none') {
    return summary
  }
  return `${summary}. High risk, ${risk === 'covered' ? 'covered' : 'not covered'} for M5`
}

function HeatTile({ cell, risk }: { cell: GridCell; risk: RiskStatus }) {
  const label = describeCell(cell, risk)
  const riskClass = risk === 'none' ? '' : ' heat-high-risk'
  if (cell.attempts === 0) {
    return (
      <li className={`heat-tile heat-untested${riskClass}`} aria-label={label} title={label}>
        <span className="heat-name">{humanize(cell.subcategory)}</span>
        <span className="heat-value">Untested</span>
      </li>
    )
  }
  return (
    <li className={`heat-tile heat-${cell.level}${riskClass}`} aria-label={label} title={label}>
      <span className="heat-name">{humanize(cell.subcategory)}</span>
      <span className="heat-value">{cell.attempts}</span>
      {cell.confirmed > 0 && <span className="heat-confirmed">{`${cell.confirmed} confirmed`}</span>}
    </li>
  )
}

export interface CoverageHeatmapProps {
  cells: CoverageCell[]
  m5: M5Summary
  /** Categories outside this list are labelled as extras. */
  prdCategories: CoverageCell['category'][]
}

function riskOf(cell: CoverageCell, m5: M5Summary): RiskStatus {
  const key = cellKey(cell)
  if (!m5.highRiskKeys.includes(key)) {
    return 'none'
  }
  return m5.coveredKeys.includes(key) ? 'covered' : 'uncovered'
}

/** Category × subcategory grid: shade is attempt volume, dashed tiles are untested gaps. */
export function CoverageHeatmap({ cells, m5, prdCategories }: CoverageHeatmapProps) {
  const rows = coverageGrid(cells)
  const untested = cells.filter((cell) => cell.attempts === 0).length
  const percent = m5.total === 0 ? 0 : Math.round((m5.covered / m5.total) * 100)

  return (
    <figure className="heatmap">
      <div className="m5-summary">
        <p className="m5-headline">{`M5: ${m5.covered} of ${m5.total} high-risk cells covered (${percent}%)`}</p>
        <p className="muted">
          {`Covered = at least ${m5.minAttempts} attempts and a run in the last ${m5.windowDays} days. Variant families are not yet counted.`}
        </p>
      </div>
      <figcaption>
        <span>{`${untested} of ${cells.length} cells untested on this version.`}</span>
        <span className="heat-legend" aria-hidden="true">
          Attempts: fewer
          {Array.from({ length: HEAT_LEVELS }, (_, index) => (
            <span key={index} className={`heat-swatch heat-${index + 1}`} />
          ))}
          more
          <span className="heat-swatch heat-untested" /> untested
          <span className="heat-swatch heat-high-risk" /> high risk (M5)
        </span>
      </figcaption>
      {rows.map((row) => {
        const label = prdCategories.includes(row.category)
          ? humanize(row.category)
          : `${humanize(row.category)} (outside PRD set)`
        return (
          <div key={row.category} className="heat-row" role="group" aria-label={label}>
            <p className="heat-category">{label}</p>
            <ul className="heat-cells">
              {row.cells.map((cell) => (
                <HeatTile key={cell.subcategory} cell={cell} risk={riskOf(cell, m5)} />
              ))}
            </ul>
          </div>
        )
      })}
    </figure>
  )
}
