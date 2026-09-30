/**
 * KEY_METRICS.md M4: confirmed-exploit rate per 100 novel attempts, per target
 * version. The Judge keeps one rubric per category (`category@hash`), so a
 * version is judged by several rubrics at once; that is not a change. Two
 * versions are not comparable when a category they share was judged under
 * different rubric hashes, and the chart never joins them.
 */

/** Novel, judged attempts on one target version under one rubric version. */
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

/** One M4 value: a target version, summed across its categories. */
export interface VersionPoint {
  targetVersion: string
  versionIndex: number
  novelAttempts: number
  confirmed: number
  rate: number
  /** The rubric versions that judged this version, sorted. */
  rubrics: string[]
}

export interface TrendSegment {
  from: VersionPoint
  to: VersionPoint
}

/** A version whose rubric differs from the previous plotted version's for a shared category. */
export interface RubricChange {
  versionIndex: number
  targetVersion: string
  previousVersion: string
  /** The categories whose rubric changed; `*` for a single rubric covering every category. */
  categories: string[]
}

export interface TrendLayout {
  points: VersionPoint[]
  segments: TrendSegment[]
  rubricChanges: RubricChange[]
}

/** Every category shares a bare (un-prefixed) rubric hash. */
export const ALL_CATEGORIES = '*'

export function ratePer100({ novelAttempts, confirmed }: Pick<ResiliencePoint, 'novelAttempts' | 'confirmed'>) {
  if (novelAttempts === 0) {
    return undefined
  }
  return Math.round((confirmed / novelAttempts) * 1000) / 10
}

/** `data_exfiltration@e1fa80ca` belongs to data_exfiltration; a bare hash covers every category. */
export function rubricCategory(rubricVersion: string): string {
  const at = rubricVersion.lastIndexOf('@')
  return at > 0 ? rubricVersion.slice(0, at) : ALL_CATEGORIES
}

function versionPoint(trend: ResilienceTrend, targetVersion: string, versionIndex: number): VersionPoint | undefined {
  const rows = trend.points.filter((point) => point.targetVersion === targetVersion && point.novelAttempts > 0)
  const novelAttempts = rows.reduce((sum, row) => sum + row.novelAttempts, 0)
  const confirmed = rows.reduce((sum, row) => sum + row.confirmed, 0)
  const rate = ratePer100({ novelAttempts, confirmed })
  if (rate === undefined) {
    return undefined
  }
  const rubrics = [...new Set(rows.map((row) => row.rubricVersion))].sort()
  return { targetVersion, versionIndex, novelAttempts, confirmed, rate, rubrics }
}

function rubricsByCategory(point: VersionPoint): Map<string, string[]> {
  return point.rubrics.reduce((byCategory, rubric) => {
    const category = rubricCategory(rubric)
    return byCategory.set(category, [...(byCategory.get(category) ?? []), rubric])
  }, new Map<string, string[]>())
}

/** Categories judged in both versions whose rubrics differ. */
function changedCategories(previous: VersionPoint, next: VersionPoint): string[] {
  const before = rubricsByCategory(previous)
  const after = rubricsByCategory(next)
  return [...after.keys()]
    .filter((category) => {
      const old = before.get(category)
      return old !== undefined && old.join('|') !== (after.get(category) ?? []).join('|')
    })
    .sort()
}

/**
 * One point per version with data. Adjacent versions are joined unless a shared
 * category's rubric changed; a version with no data also breaks the line.
 */
export function buildTrendSeries(trend: ResilienceTrend): TrendLayout {
  const points = trend.versions
    .map((version, index) => versionPoint(trend, version, index))
    .filter((point): point is VersionPoint => point !== undefined)
  const pairs = points.slice(1).flatMap((to, index) => {
    const from = points[index]
    return from ? [{ from, to, changed: changedCategories(from, to) }] : []
  })
  const segments = pairs
    .filter((pair) => pair.changed.length === 0 && pair.to.versionIndex - pair.from.versionIndex === 1)
    .map(({ from, to }) => ({ from, to }))
  const rubricChanges = pairs
    .filter((pair) => pair.changed.length > 0)
    .map((pair) => ({
      versionIndex: pair.to.versionIndex,
      targetVersion: pair.to.targetVersion,
      previousVersion: pair.from.targetVersion,
      categories: pair.changed,
    }))
  return { points, segments, rubricChanges }
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
