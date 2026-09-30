import { describe, expect, it } from 'vitest'

import { axisTicks, buildTrendSeries, ratePer100, type ResilienceTrend } from '../resilience.js'

const trend: ResilienceTrend = {
  versions: ['v1', 'v2', 'v3', 'v4', 'v5'],
  points: [
    { targetVersion: 'v1', rubricVersion: 'r-a', novelAttempts: 200, confirmed: 6 },
    { targetVersion: 'v2', rubricVersion: 'r-a', novelAttempts: 100, confirmed: 2 },
    { targetVersion: 'v3', rubricVersion: 'r-a', novelAttempts: 50, confirmed: 1 },
    { targetVersion: 'v3', rubricVersion: 'r-b', novelAttempts: 400, confirmed: 4 },
    { targetVersion: 'v4', rubricVersion: 'r-b', novelAttempts: 0, confirmed: 0 },
    { targetVersion: 'v5', rubricVersion: 'r-b', novelAttempts: 100, confirmed: 3 },
  ],
}

describe('ratePer100', () => {
  it('is confirmed exploits per 100 novel attempts', () => {
    expect(ratePer100({ novelAttempts: 400, confirmed: 6 })).toBe(1.5)
  })

  it('is undefined with no novel attempts', () => {
    expect(ratePer100({ novelAttempts: 0, confirmed: 0 })).toBeUndefined()
  })
})

describe('buildTrendSeries', () => {
  const series = buildTrendSeries(trend)

  it('makes one series per rubric, in the order the rubrics first appear', () => {
    expect(series.series.map((entry) => entry.rubricVersion)).toEqual(['r-a', 'r-b'])
  })

  it('drops points without novel attempts', () => {
    const rubricB = series.series[1]
    expect(rubricB?.points.map((point) => point.targetVersion)).toEqual(['v3', 'v5'])
  })

  it('connects only consecutive versions judged by the same rubric', () => {
    const segments = series.segments.map(
      (segment) => `${segment.rubricVersion}:${segment.from.targetVersion}-${segment.to.targetVersion}`,
    )
    expect(segments).toEqual(['r-a:v1-v2', 'r-a:v2-v3'])
  })

  it('never connects across a rubric change or a version with no data', () => {
    const crossing = series.segments.filter((segment) => segment.from.rubricVersion !== segment.to.rubricVersion)
    expect(crossing).toEqual([])
    expect(series.segments.some((segment) => segment.to.targetVersion === 'v5')).toBe(false)
  })

  it('marks the version where each later rubric first appears', () => {
    expect(series.rubricChanges).toEqual([{ versionIndex: 2, rubricVersion: 'r-b' }])
  })

  it('gives each version its index on the x axis', () => {
    expect(series.series[0]?.points.map((point) => point.versionIndex)).toEqual([0, 1, 2])
  })
})

describe('axisTicks', () => {
  it('steps the axis in clean increments that cover the maximum', () => {
    expect(axisTicks(3.4)).toEqual([0, 1, 2, 3, 4])
    expect(axisTicks(0.7)).toEqual([0, 0.2, 0.4, 0.6, 0.8])
    expect(axisTicks(12)).toEqual([0, 5, 10, 15])
  })

  it('still draws an axis with no data', () => {
    expect(axisTicks(0)).toEqual([0, 1])
  })
})
