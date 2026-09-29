// @vitest-environment node
import { validateRerunRequest } from '@agentforge/contracts'
import { describe, expect, it } from 'vitest'

import type { QueueItem } from '../models.js'
import { buildRerunRequest, estimateRerunCostUsd, moveItem, planTonight } from '../queue.js'

function item(id: string, estimatedCostUsd: number): QueueItem {
  return {
    id,
    kind: 'rerun',
    exploitId: `AF-${id}`,
    requestedBy: 'operator',
    requestedAt: '2026-09-29T10:00:00Z',
    source: 'ui',
    estimatedCostUsd,
  }
}

describe('planTonight', () => {
  it('keeps a running total and cuts everything after the envelope is exceeded', () => {
    const plan = planTonight([item('a', 4), item('b', 5), item('c', 3), item('d', 1)], 10)
    expect(plan.map((row) => [row.id, row.cumulativeUsd, row.cut])).toEqual([
      ['a', 4, false],
      ['b', 9, false],
      ['c', 12, true],
      ['d', 13, true],
    ])
  })

  it('numbers positions from 1 in queue order', () => {
    expect(planTonight([item('a', 1), item('b', 1)], 10).map((row) => row.position)).toEqual([1, 2])
  })
})

describe('moveItem', () => {
  const items = [item('a', 1), item('b', 1), item('c', 1)]

  it('swaps an item with its neighbour', () => {
    expect(moveItem(items, 'b', 'up').map((row) => row.id)).toEqual(['b', 'a', 'c'])
    expect(moveItem(items, 'b', 'down').map((row) => row.id)).toEqual(['a', 'c', 'b'])
  })

  it('leaves the order alone at the edges or for unknown ids', () => {
    expect(moveItem(items, 'a', 'up').map((row) => row.id)).toEqual(['a', 'b', 'c'])
    expect(moveItem(items, 'c', 'down').map((row) => row.id)).toEqual(['a', 'b', 'c'])
    expect(moveItem(items, 'zzz', 'up').map((row) => row.id)).toEqual(['a', 'b', 'c'])
  })

  it('does not mutate its input', () => {
    moveItem(items, 'b', 'up')
    expect(items.map((row) => row.id)).toEqual(['a', 'b', 'c'])
  })
})

describe('estimateRerunCostUsd', () => {
  it('scales with the variant family size', () => {
    expect(estimateRerunCostUsd(4)).toBeGreaterThan(estimateRerunCostUsd(1))
  })
})

describe('buildRerunRequest', () => {
  it('produces a valid RerunRequest v1 for an exploit', () => {
    const request = buildRerunRequest({
      messageId: '6f1c2b1e-9a43-4d3b-8f1e-2a7c5d9e0b11',
      exploitId: 'AF-2026-0007',
      requestedBy: 'operator',
      requestedFor: '2026-09-29',
      reason: 'focus on exfiltration',
    })
    const result = validateRerunRequest(request)
    expect(result.errors).toEqual([])
    expect(request.target).toEqual({ kind: 'exploit', exploit_id: 'AF-2026-0007' })
    expect(request.source).toBe('ui')
  })

  it('omits an empty reason instead of sending a blank string', () => {
    const request = buildRerunRequest({
      messageId: '6f1c2b1e-9a43-4d3b-8f1e-2a7c5d9e0b11',
      exploitId: 'AF-2026-0007',
      requestedBy: 'operator',
      requestedFor: '2026-09-29',
      reason: '   ',
    })
    expect('reason' in request).toBe(false)
    expect(validateRerunRequest(request).valid).toBe(true)
  })
})
