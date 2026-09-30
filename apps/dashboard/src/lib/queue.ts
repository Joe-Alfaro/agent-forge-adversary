import type { RerunRequest } from '@agentforge/contracts'

import type { QueueItem } from './models.js'

/** Replays per exploit in a regression re-check (Section 9.2 majority vote). */
const REPLAYS_PER_EXPLOIT = 3
/** Midpoint of the Section 13.3 per-case estimate ($0.03–0.07). */
const COST_PER_CASE_USD = 0.05

/** Rough cost of re-checking an exploit and its whole variant family tonight. */
export function estimateRerunCostUsd(familySize: number): number {
  return Math.round(familySize * REPLAYS_PER_EXPLOIT * COST_PER_CASE_USD * 100) / 100
}

export type MoveDirection = 'up' | 'down'

/** Swaps an item with its neighbour; out-of-range moves return the same order. */
export function moveItem<T extends { id: string }>(items: readonly T[], id: string, direction: MoveDirection): T[] {
  const from = items.findIndex((item) => item.id === id)
  const to = direction === 'up' ? from - 1 : from + 1
  const moving = items[from]
  const neighbour = items[to]
  if (from === -1 || !moving || !neighbour) {
    return [...items]
  }
  return items.map((item, index) => {
    if (index === from) {
      return neighbour
    }
    if (index === to) {
      return moving
    }
    return item
  })
}

export interface RerunInput {
  messageId: string
  exploitId: string
  requestedBy: string
  requestedFor: string
  reason?: string
}

/** Builds the `RerunRequest v1` message the "Re-check tonight" button sends. */
export function buildRerunRequest(input: RerunInput): RerunRequest {
  const request: RerunRequest = {
    schema_version: '1',
    message_id: input.messageId,
    requested_by: input.requestedBy,
    requested_for: input.requestedFor,
    source: 'ui',
    target: { kind: 'exploit', exploit_id: input.exploitId },
  }
  const reason = input.reason?.trim()
  if (!reason) {
    return request
  }
  return { ...request, reason }
}
