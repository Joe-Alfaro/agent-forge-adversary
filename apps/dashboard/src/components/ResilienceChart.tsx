import { useState } from 'react'

import { humanize } from '../lib/format.js'
import {
  ALL_CATEGORIES,
  axisTicks,
  buildTrendSeries,
  type ResilienceTrend,
  type RubricChange,
  type VersionPoint,
} from '../lib/resilience.js'

/*
 * KEY_METRICS M4 as a line chart: x is target versions in release order, y is
 * confirmed exploits per 100 novel attempts, one point per version. The Judge
 * keeps one rubric per category, so several rubrics per version is normal; the
 * line breaks only where a category's rubric changed between versions. One
 * series, so one color (dataviz reference slot 1) and no legend.
 */

const LINE_COLOR = '#2a78d6'

const WIDTH = 720
const HEIGHT = 280
const MARGIN = { top: 28, right: 56, bottom: 36, left: 44 }
const PLOT_WIDTH = WIDTH - MARGIN.left - MARGIN.right
const PLOT_HEIGHT = HEIGHT - MARGIN.top - MARGIN.bottom

const count = new Intl.NumberFormat('en-US')

function formatRate(rate: number): string {
  return rate.toFixed(1)
}

function pointSummary(point: VersionPoint): string {
  return `${formatRate(point.rate)} per 100 (${count.format(point.confirmed)} of ${count.format(point.novelAttempts)})`
}

function changedRubrics(change: RubricChange): string {
  if (change.categories.includes(ALL_CATEGORIES)) {
    return 'The Judge rubric'
  }
  const names = change.categories.map(humanize).join(', ')
  return `The ${names} rubric${change.categories.length === 1 ? '' : 's'}`
}

function categoryCount(point: VersionPoint): string {
  const categories = point.rubrics.length
  return `${categories} ${categories === 1 ? 'category' : 'categories'}`
}

export interface ResilienceChartProps {
  trend: ResilienceTrend
}

export function ResilienceChart({ trend }: ResilienceChartProps) {
  const [active, setActive] = useState<number | null>(null)
  const { points, segments, rubricChanges } = buildTrendSeries(trend)

  if (points.length === 0) {
    return <p className="muted">No judged novel attempts yet.</p>
  }

  const ticks = axisTicks(Math.max(...points.map((point) => point.rate)))
  const yMax = ticks.at(-1) ?? 1
  const band = PLOT_WIDTH / trend.versions.length

  function x(versionIndex: number): number {
    return MARGIN.left + band * (versionIndex + 0.5)
  }

  function y(rate: number): number {
    return MARGIN.top + PLOT_HEIGHT * (1 - rate / yMax)
  }

  function changeAt(versionIndex: number): RubricChange | undefined {
    return rubricChanges.find((change) => change.versionIndex === versionIndex)
  }

  function versionLabel(version: string, versionIndex: number): string {
    const point = points.find((candidate) => candidate.versionIndex === versionIndex)
    return point ? `${version}: ${pointSummary(point)}` : `${version}: no judged novel attempts`
  }

  const newest = points.at(-1) ?? points[0]
  const activePoint = points.find((point) => point.versionIndex === active)
  const activeChange = active === null ? undefined : changeAt(active)

  return (
    <figure className="trend-chart">
      <figcaption>
        {points.length === 1 && (
          <p className="trend-note">One target version so far; the trend appears once a second version is tested.</p>
        )}
        {rubricChanges.map((change) => (
          <p key={change.targetVersion} className="trend-note">
            {changedRubrics(change)} changed at {change.targetVersion}, so that version is not joined to{' '}
            {change.previousVersion} (KEY_METRICS M4).
          </p>
        ))}
      </figcaption>

      <div className="trend-plot">
        <svg
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          role="img"
          aria-label="Confirmed-exploit rate per 100 novel attempts by target version"
        >
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

          {rubricChanges.map((change) => {
            const boundary = MARGIN.left + band * change.versionIndex
            return (
              <g key={change.targetVersion}>
                <line
                  className="rubric-change"
                  x1={boundary}
                  x2={boundary}
                  y1={MARGIN.top - 12}
                  y2={MARGIN.top + PLOT_HEIGHT}
                />
                <text className="axis-label" x={boundary + 4} y={MARGIN.top - 14}>
                  Rubric changed
                </text>
              </g>
            )
          })}

          {active !== null && (
            <line className="crosshair" x1={x(active)} x2={x(active)} y1={MARGIN.top} y2={MARGIN.top + PLOT_HEIGHT} />
          )}

          {segments.map((segment) => (
            <path
              key={segment.from.targetVersion}
              data-segment={`${segment.from.targetVersion}→${segment.to.targetVersion}`}
              className="trend-line"
              stroke={LINE_COLOR}
              d={`M${x(segment.from.versionIndex)},${y(segment.from.rate)} L${x(segment.to.versionIndex)},${y(segment.to.rate)}`}
            />
          ))}
          {points.map((point) => (
            <circle
              key={point.targetVersion}
              className="trend-point"
              cx={x(point.versionIndex)}
              cy={y(point.rate)}
              r={active === point.versionIndex ? 5 : 4}
              fill={LINE_COLOR}
            />
          ))}
          {newest && (
            <text className="value-label" x={x(newest.versionIndex) + 10} y={y(newest.rate)} dominantBaseline="middle">
              {formatRate(newest.rate)}
            </text>
          )}

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

        {active !== null && (
          <div
            role="tooltip"
            className="chart-tooltip"
            style={{ left: `${(x(active) / WIDTH) * 100}%`, top: `${(MARGIN.top / HEIGHT) * 100}%` }}
          >
            <strong>{trend.versions[active]}</strong>
            {activePoint ? (
              <span>{pointSummary(activePoint)}</span>
            ) : (
              <span className="muted">No judged novel attempts</span>
            )}
            {activePoint && <span className="muted">{activePoint.rubrics.length} per-category rubrics</span>}
            {activeChange && (
              <span className="muted">
                {changedRubrics(activeChange).replace(/^The /, '')} changed since {activeChange.previousVersion}
              </span>
            )}
          </div>
        )}
      </div>

      <table className="data-table trend-table">
        <caption className="visually-hidden">Confirmed exploits per 100 novel attempts, by target version</caption>
        <thead>
          <tr>
            <th scope="col">Target version</th>
            <th scope="col">Novel attempts</th>
            <th scope="col">Confirmed</th>
            <th scope="col">Per 100</th>
            <th scope="col">Judged under</th>
          </tr>
        </thead>
        <tbody>
          {points.map((point) => (
            <tr key={point.targetVersion}>
              <td>{point.targetVersion}</td>
              <td>{count.format(point.novelAttempts)}</td>
              <td>{count.format(point.confirmed)}</td>
              <td>{formatRate(point.rate)}</td>
              <td title={point.rubrics.join('\n')}>{categoryCount(point)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  )
}
