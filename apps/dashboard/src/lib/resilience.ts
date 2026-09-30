/**
 * KEY_METRICS.md M4: confirmed-exploit rate per 100 novel attempts, per target
 * version. Rates judged under different rubric versions are not comparable, so
 * each rubric is its own series and the chart never joins points across rubrics.
 */

/** Novel, judged attempts on one target version under one rubric. */
export interface ResiliencePoint {
  targetVersion: string
  rubricVersion: string
  novelAttempts: number
  confirmed: number
}

export interface ResilienceTrend {
  /** Every target version, oldest first; the x axis. */
  versions: string[]
  points: ResiliencePoint[]
}

export interface PlottedPoint extends ResiliencePoint {
  versionIndex: number
  rate: number
}

export interface TrendSeries {
  rubricVersion: string
  points: PlottedPoint[]
}

export interface TrendSegment {
  rubricVersion: string
  from: PlottedPoint
  to: PlottedPoint
}

export interface RubricChange {
  versionIndex: number
  rubricVersion: string
}

export interface TrendLayout {
  series: TrendSeries[]
  segments: TrendSegment[]
  /** Where each rubric after the first starts: the line breaks here. */
  rubricChanges: RubricChange[]
}

export function ratePer100({ novelAttempts, confirmed }: Pick<ResiliencePoint, 'novelAttempts' | 'confirmed'>) {
  if (novelAttempts === 0) {
    return undefined
  }
  return Math.round((confirmed / novelAttempts) * 1000) / 10
}

function plotted(point: ResiliencePoint, versions: readonly string[]): PlottedPoint | undefined {
  const rate = ratePer100(point)
  const versionIndex = versions.indexOf(point.targetVersion)
  if (rate === undefined || versionIndex === -1) {
    return undefined
  }
  return { ...point, versionIndex, rate }
}

/**
 * Groups points into one series per rubric (in order of first appearance) and
 * joins a series' points only when their versions are adjacent on the axis, so
 * a version with no data also breaks the line.
 */
export function buildTrendSeries(trend: ResilienceTrend): TrendLayout {
  const points = trend.points
    .map((point) => plotted(point, trend.versions))
    .filter((point): point is PlottedPoint => point !== undefined)
    .sort((a, b) => a.versionIndex - b.versionIndex)
  const rubrics = [...new Set(points.map((point) => point.rubricVersion))]
  const series = rubrics.map((rubricVersion) => ({
    rubricVersion,
    points: points.filter((point) => point.rubricVersion === rubricVersion),
  }))
  const segments = series.flatMap((entry) =>
    entry.points.slice(1).flatMap((to, index) => {
      const from = entry.points[index]
      return from && to.versionIndex - from.versionIndex === 1 ? [{ rubricVersion: entry.rubricVersion, from, to }] : []
    }),
  )
  const rubricChanges = series.slice(1).flatMap((entry) => {
    const first = entry.points[0]
    return first ? [{ versionIndex: first.versionIndex, rubricVersion: entry.rubricVersion }] : []
  })
  return { series, segments, rubricChanges }
}

const STEPS = [1, 2, 5, 10]

/** Axis ticks from 0 in steps of 1, 2, or 5 × 10^n, about four intervals, ending at or above `max`. */
export function axisTicks(max: number): number[] {
  if (max <= 0) {
    return [0, 1]
  }
  const raw = max / 4
  const magnitude = 10 ** Math.floor(Math.log10(raw))
  const step = (STEPS.find((candidate) => candidate * magnitude >= raw) ?? 10) * magnitude
  const count = Math.ceil(max / step - 1e-9)
  // Rounding keeps float steps such as 0.2 × 3 printing as 0.6.
  return Array.from({ length: count + 1 }, (_, index) => Math.round(index * step * 1e6) / 1e6)
}

/** Rubric hashes are long; the chart shows a short prefix, as git does. */
export function shortRubric(rubricVersion: string): string {
  const hash = rubricVersion.includes(':') ? rubricVersion.slice(rubricVersion.indexOf(':') + 1) : rubricVersion
  return hash.slice(0, 8)
}
