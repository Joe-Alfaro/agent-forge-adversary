// @vitest-environment node
import { validateRerunRequest } from '@agentforge/contracts'
import { describe, expect, it } from 'vitest'

import type { QueueItem } from '../models.js'
import { buildRerunRequest, estimateRerunCostUsd, moveItem } from '../queue.js'

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
