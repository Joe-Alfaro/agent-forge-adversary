import { useState } from 'react'

import {
  axisTicks,
  buildTrendSeries,
  type PlottedPoint,
  type ResilienceTrend,
  shortRubric,
} from '../lib/resilience.js'

/*
 * KEY_METRICS M4 as a line chart: x is target versions in release order, y is
 * confirmed exploits per 100 novel attempts. Each Judge rubric is its own
 * series, and lines join only adjacent versions under the same rubric.
 * Colors are the dataviz reference categorical slots, assigned in the order
 * rubrics were introduced, so a rubric keeps its color as history grows.
 */

const SERIES_COLORS = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948']
/** Past eight rubrics the oldest fold to one neutral, rather than inventing a ninth hue. */
const FOLDED_COLOR = '#98a2b3'

const WIDTH = 720
const HEIGHT = 280
const MARGIN = { top: 28, right: 56, bottom: 36, left: 44 }
const PLOT_WIDTH = WIDTH - MARGIN.left - MARGIN.right
const PLOT_HEIGHT = HEIGHT - MARGIN.top - MARGIN.bottom

const count = new Intl.NumberFormat('en-US')

function seriesColor(index: number, total: number): string {
  const folded = Math.max(0, total - SERIES_COLORS.length)
  if (index < folded) {
    return FOLDED_COLOR
  }
  return SERIES_COLORS[index - folded] ?? FOLDED_COLOR
}

function formatRate(rate: number): string {
  return rate.toFixed(1)
}

function pointSummary(point: PlottedPoint): string {
  return `${formatRate(point.rate)} per 100 (${count.format(point.confirmed)} of ${count.format(point.novelAttempts)})`
}

export interface ResilienceChartProps {
  trend: ResilienceTrend
}

export function ResilienceChart({ trend }: ResilienceChartProps) {
  const [active, setActive] = useState<number | null>(null)
  const layout = buildTrendSeries(trend)
  const points = layout.series.flatMap((entry) => entry.points)

  if (points.length === 0) {
    return <p className="muted">No judged novel attempts yet.</p>
  }

  const ticks = axisTicks(Math.max(...points.map((point) => point.rate)))
  const yMax = ticks.at(-1) ?? 1
  const band = PLOT_WIDTH / trend.versions.length
  const colorByRubric = new Map(
    layout.series.map((entry, index) => [entry.rubricVersion, seriesColor(index, layout.series.length)]),
  )

  function x(versionIndex: number): number {
    return MARGIN.left + band * (versionIndex + 0.5)
  }

  function y(rate: number): number {
    return MARGIN.top + PLOT_HEIGHT * (1 - rate / yMax)
  }

  function pointsAt(versionIndex: number): PlottedPoint[] {
    return points.filter((point) => point.versionIndex === versionIndex)
  }

  function versionLabel(version: string, versionIndex: number): string {
    const here = pointsAt(versionIndex)
    if (here.length === 0) {
      return `${version}: no judged novel attempts`
    }
    const values = here.map((point) => `${pointSummary(point)} under rubric ${shortRubric(point.rubricVersion)}`)
    return `${version}: ${values.join('; ')}`
  }

  const tableRows = [...points].sort((a, b) => a.versionIndex - b.versionIndex)
  const newest = points.reduce((latest, point) => (point.versionIndex > latest.versionIndex ? point : latest))
  const activePoints = active === null ? [] : pointsAt(active)
  const activeVersion = active === null ? undefined : trend.versions[active]

  return (
    <figure className="trend-chart">
      <figcaption>
        {layout.series.length > 1 && (
          <ul className="trend-legend" aria-label="Rubric versions">
            {layout.series.map((entry) => (
              <li key={entry.rubricVersion}>
                <span className="line-key" style={{ background: colorByRubric.get(entry.rubricVersion) }} />
                Rubric {shortRubric(entry.rubricVersion)}
              </li>
            ))}
          </ul>
        )}
        {layout.rubricChanges.map((change) => (
          <p key={change.rubricVersion} className="trend-note">
            Rubric {shortRubric(change.rubricVersion)} starts at {trend.versions[change.versionIndex]}. Rates judged
            under different rubrics are not comparable, so the line breaks there (KEY_METRICS M4).
          </p>
        ))}
      </figcaption>

      <div className="trend-plot">
        <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-label="Confirmed-exploit rate per 100 novel attempts by target version">
          {ticks.map((tick) => (
            <g key={tick}>
              <line className="grid" x1={MARGIN.left} x2={WIDTH - MARGIN.right} y1={y(tick)} y2={y(tick)} />
              <text className="axis-label" x={MARGIN.left - 8} y={y(tick)} textAnchor="end" dominantBaseline="middle">
                {tick}
              </text>
            </g>
          ))}
          {trend.versions.map((version, index) => (
            <text key={version} className="axis-label" x={x(index)} y={HEIGHT - 12} textAnchor="middle">
              {version}
            </text>
          ))}

          {layout.rubricChanges.map((change) => {
            const boundary = MARGIN.left + band * change.versionIndex
            return (
              <g key={change.rubricVersion}>
                <line className="rubric-change" x1={boundary} x2={boundary} y1={MARGIN.top - 12} y2={MARGIN.top + PLOT_HEIGHT} />
                <text className="axis-label" x={boundary + 4} y={MARGIN.top - 14}>
                  Rubric changed
                </text>
              </g>
            )
          })}

          {active !== null && (
            <line className="crosshair" x1={x(active)} x2={x(active)} y1={MARGIN.top} y2={MARGIN.top + PLOT_HEIGHT} />
          )}

          {layout.segments.map((segment) => (
            <path
              key={`${segment.rubricVersion}:${segment.from.versionIndex}`}
              data-segment={`${shortRubric(segment.rubricVersion)}:${segment.from.targetVersion}→${segment.to.targetVersion}`}
              className="trend-line"
              stroke={colorByRubric.get(segment.rubricVersion)}
              d={`M${x(segment.from.versionIndex)},${y(segment.from.rate)} L${x(segment.to.versionIndex)},${y(segment.to.rate)}`}
            />
          ))}
          {points.map((point) => (
            <circle
              key={`${point.rubricVersion}:${point.versionIndex}`}
              className="trend-point"
              cx={x(point.versionIndex)}
              cy={y(point.rate)}
              r={active === point.versionIndex ? 5 : 4}
              fill={colorByRubric.get(point.rubricVersion)}
            />
          ))}
          <text className="value-label" x={x(newest.versionIndex) + 10} y={y(newest.rate)} dominantBaseline="middle">
            {formatRate(newest.rate)}
          </text>

          {trend.versions.map((version, index) => (
            <rect
              key={version}
              className="hit-band"
              x={MARGIN.left + band * index}
              y={MARGIN.top}
              width={band}
              height={PLOT_HEIGHT}
              tabIndex={0}
              aria-label={versionLabel(version, index)}
              onMouseEnter={() => setActive(index)}
              onMouseLeave={() => setActive(null)}
              onFocus={() => setActive(index)}
              onBlur={() => setActive(null)}
            />
          ))}
        </svg>

        {activeVersion !== undefined && active !== null && (
          <div
            role="tooltip"
            className="chart-tooltip"
            style={{ left: `${(x(active) / WIDTH) * 100}%`, top: `${(MARGIN.top / HEIGHT) * 100}%` }}
          >
            <strong>{activeVersion}</strong>
            {activePoints.length === 0 && <span className="muted">No judged novel attempts</span>}
            {activePoints.map((point) => (
              <span key={point.rubricVersion} className="tooltip-row">
                <span className="line-key" style={{ background: colorByRubric.get(point.rubricVersion) }} />
                {shortRubric(point.rubricVersion)}: {pointSummary(point)}
              </span>
            ))}
          </div>
        )}
      </div>

      <table className="data-table trend-table">
        <caption className="visually-hidden">Confirmed exploits per 100 novel attempts, by version and rubric</caption>
        <thead>
          <tr>
            <th scope="col">Target version</th>
            <th scope="col">Rubric</th>
            <th scope="col">Novel attempts</th>
            <th scope="col">Confirmed</th>
            <th scope="col">Per 100</th>
          </tr>
        </thead>
        <tbody>
          {tableRows.map((point) => (
            <tr key={`${point.rubricVersion}:${point.versionIndex}`}>
              <td>{point.targetVersion}</td>
              <td>{shortRubric(point.rubricVersion)}</td>
              <td>{count.format(point.novelAttempts)}</td>
              <td>{count.format(point.confirmed)}</td>
              <td>{formatRate(point.rate)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  )
}
