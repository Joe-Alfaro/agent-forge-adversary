import { describe, expect, it } from 'vitest'

import { axisTicks, buildTrendSeries, ratePer100, type ResilienceTrend, rubricCategory } from '../resilience.js'

/** Rubric versions are per category (`category@hash`), as the Judge writes them. */
const trend: ResilienceTrend = {
  versions: ['v1', 'v2', 'v3', 'v4', 'v5'],
  points: [
    { targetVersion: 'v1', rubricVersion: 'prompt_injection@aaaa1111', novelAttempts: 100, confirmed: 4 },
    { targetVersion: 'v1', rubricVersion: 'data_exfiltration@bbbb2222', novelAttempts: 100, confirmed: 2 },
    { targetVersion: 'v2', rubricVersion: 'prompt_injection@aaaa1111', novelAttempts: 50, confirmed: 1 },
    { targetVersion: 'v2', rubricVersion: 'data_exfiltration@bbbb2222', novelAttempts: 50, confirmed: 0 },
    // A category tested for the first time is not a rubric change.
    { targetVersion: 'v2', rubricVersion: 'tool_misuse@cccc3333', novelAttempts: 100, confirmed: 1 },
    // v3: the prompt-injection rubric was revised.
    { targetVersion: 'v3', rubricVersion: 'prompt_injection@dddd4444', novelAttempts: 200, confirmed: 2 },
    { targetVersion: 'v3', rubricVersion: 'data_exfiltration@bbbb2222', novelAttempts: 200, confirmed: 2 },
    { targetVersion: 'v4', rubricVersion: 'prompt_injection@dddd4444', novelAttempts: 0, confirmed: 0 },
    { targetVersion: 'v5', rubricVersion: 'prompt_injection@dddd4444', novelAttempts: 100, confirmed: 3 },
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

describe('rubricCategory', () => {
  it('is the category a per-category rubric version belongs to', () => {
    expect(rubricCategory('data_exfiltration@e1fa80ca')).toBe('data_exfiltration')
  })

  it('treats a bare hash as one rubric for every category', () => {
    expect(rubricCategory('sha256:4be1c09f2a7d')).toBe('*')
  })
})

describe('buildTrendSeries', () => {
  const layout = buildTrendSeries(trend)

  it('makes one M4 point per target version, summed across categories', () => {
    expect(layout.points.map((point) => [point.targetVersion, point.novelAttempts, point.confirmed, point.rate])).toEqual([
      ['v1', 200, 6, 3],
      ['v2', 200, 2, 1],
      ['v3', 400, 4, 1],
      ['v5', 100, 3, 3],
    ])
  })

  it('keeps each version’s rubrics, one per category', () => {
    expect(layout.points[1]?.rubrics).toEqual([
      'data_exfiltration@bbbb2222',
      'prompt_injection@aaaa1111',
      'tool_misuse@cccc3333',
    ])
  })

  it('connects adjacent versions whose shared categories use the same rubrics', () => {
    expect(layout.segments.map((segment) => `${segment.from.targetVersion}-${segment.to.targetVersion}`)).toEqual([
      'v1-v2',
    ])
  })

  it('does not connect across a rubric change or a version with no data', () => {
    expect(layout.segments.some((segment) => segment.to.targetVersion === 'v3')).toBe(false)
    expect(layout.segments.some((segment) => segment.to.targetVersion === 'v5')).toBe(false)
  })

  it('annotates only real rubric changes between versions, naming the categories', () => {
    expect(layout.rubricChanges).toEqual([
      { versionIndex: 2, targetVersion: 'v3', previousVersion: 'v2', categories: ['prompt_injection'] },
    ])
  })

  it('reads cleanly with a single version judged by several per-category rubrics', () => {
    const single = buildTrendSeries({
      versions: ['copilot@c1f011e'],
      points: [
        { targetVersion: 'copilot@c1f011e', rubricVersion: 'data_exfiltration@e1fa80ca', novelAttempts: 10, confirmed: 0 },
        { targetVersion: 'copilot@c1f011e', rubricVersion: 'denial_of_service@7c2d11aa', novelAttempts: 10, confirmed: 1 },
        { targetVersion: 'copilot@c1f011e', rubricVersion: 'prompt_injection@90ab44cd', novelAttempts: 20, confirmed: 1 },
      ],
    })
    expect(single.points).toHaveLength(1)
    expect(single.points[0]).toMatchObject({ novelAttempts: 40, confirmed: 2, rate: 5 })
    expect(single.rubricChanges).toEqual([])
    expect(single.segments).toEqual([])
  })

  it('treats a changed bare rubric hash as a change for every category', () => {
    const bare = buildTrendSeries({
      versions: ['a', 'b'],
      points: [
        { targetVersion: 'a', rubricVersion: 'sha256:1111', novelAttempts: 10, confirmed: 1 },
        { targetVersion: 'b', rubricVersion: 'sha256:2222', novelAttempts: 10, confirmed: 1 },
      ],
    })
    expect(bare.segments).toEqual([])
    expect(bare.rubricChanges).toEqual([{ versionIndex: 1, targetVersion: 'b', previousVersion: 'a', categories: ['*'] }])
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
