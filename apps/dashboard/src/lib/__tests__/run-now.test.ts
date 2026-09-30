import { describe, expect, it } from 'vitest'

import type { QueueItem } from '../models.js'
import { buildRunNowPlan, estimateRunNow, isRunNowActive, parseRunNowScope, scopedItems } from '../run-now.js'

function item(id: string, estimatedCostUsd: number): QueueItem {
  return {
    id,
    kind: 'rerun',
    exploitId: 'AF-1',
    requestedBy: 'dana',
    requestedAt: '2026-09-29T08:00:00Z',
    source: 'ui',
    estimatedCostUsd,
  }
}

const items = [item('a', 12.5), item('b', 0.6), item('c', 14)]

describe('parseRunNowScope', () => {
  it('accepts the whole queue or one operator request', () => {
    expect(parseRunNowScope({ kind: 'queue' })).toEqual({ kind: 'queue' })
    expect(parseRunNowScope({ kind: 'single', operatorRequestId: 'req-1' })).toEqual({
      kind: 'single',
      operatorRequestId: 'req-1',
    })
  })

  it('drops unknown fields and rejects anything else', () => {
    expect(parseRunNowScope({ kind: 'queue', extra: 1 })).toEqual({ kind: 'queue' })
    expect(() => parseRunNowScope({ kind: 'single' })).toThrow('operatorRequestId')
    expect(() => parseRunNowScope({ kind: 'all' })).toThrow('scope')
    expect(() => parseRunNowScope(null)).toThrow('scope')
  })
})

describe('scopedItems', () => {
  it('is the whole queue in order, or the one request', () => {
    expect(scopedItems(items, { kind: 'queue' }).map((entry) => entry.id)).toEqual(['a', 'b', 'c'])
    expect(scopedItems(items, { kind: 'single', operatorRequestId: 'b' }).map((entry) => entry.id)).toEqual(['b'])
    expect(scopedItems(items, { kind: 'single', operatorRequestId: 'zz' })).toEqual([])
  })
})

describe('estimateRunNow', () => {
  it('sums the queued estimates and compares them with the envelope', () => {
    expect(estimateRunNow(items, { kind: 'queue' }, 25)).toEqual({
      itemCount: 3,
      estimatedUsd: 27.1,
      envelopeUsd: 25,
      exceedsEnvelope: true,
    })
  })

  it('uses the single item’s estimate for one request', () => {
    expect(estimateRunNow(items, { kind: 'single', operatorRequestId: 'b' }, 25)).toEqual({
      itemCount: 1,
      estimatedUsd: 0.6,
      envelopeUsd: 25,
      exceedsEnvelope: false,
    })
  })
})

describe('buildRunNowPlan', () => {
  it('is exactly { scope, requested_by, requested_at } for the executor', () => {
    expect(
      buildRunNowPlan({ kind: 'single', operatorRequestId: 'b' }, 'operator', new Date('2026-09-29T20:00:00Z')),
    ).toEqual({
      scope: { kind: 'single', operatorRequestId: 'b' },
      requested_by: 'operator',
      requested_at: '2026-09-29T20:00:00.000Z',
    })
  })
})

describe('isRunNowActive', () => {
  it('is true until the run finishes one way or another', () => {
    expect(isRunNowActive('scheduled')).toBe(true)
    expect(isRunNowActive('running')).toBe(true)
    expect(isRunNowActive('completed')).toBe(false)
    expect(isRunNowActive('failed')).toBe(false)
    expect(isRunNowActive('aborted')).toBe(false)
  })
})
