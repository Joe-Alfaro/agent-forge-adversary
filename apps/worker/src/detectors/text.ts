import type { AttackTranscript } from '@agentforge/contracts'

import type { ResponseString } from './types.js'

/**
 * Every string value in the target's responses, with the turn it came from.
 *
 * Detectors search the TARGET's output, never the attacker's message — a canary
 * the attacker pasted into a prompt is not evidence the target leaked it. The
 * walk is recursive because the Co-Pilot answers with a structured `claims`
 * array whose quoted values are nested, not a flat string.
 */
export function collectResponseStrings(transcript: AttackTranscript): ResponseString[] {
  const out: ResponseString[] = []
  transcript.turns.forEach((turn) => {
    walk(turn.target_response, (text) => out.push({ turnIndex: turn.index, text }))
  })
  return out
}

function walk(value: unknown, emit: (text: string) => void): void {
  if (typeof value === 'string') {
    emit(value)
    return
  }
  if (Array.isArray(value)) {
    value.forEach((item) => walk(item, emit))
    return
  }
  if (typeof value === 'object' && value !== null) {
    Object.values(value).forEach((item) => walk(item, emit))
  }
}

/**
 * A short window of text around a match, for evidence. Bounded so a whole
 * response body never lands in a detector result.
 */
export function excerptAround(haystack: string, needle: string, radius = 40): string {
  const at = haystack.toLowerCase().indexOf(needle.toLowerCase())
  if (at < 0) {
    return haystack.slice(0, radius * 2)
  }
  const start = Math.max(0, at - radius)
  const end = Math.min(haystack.length, at + needle.length + radius)
  return `${start > 0 ? '…' : ''}${haystack.slice(start, end)}${end < haystack.length ? '…' : ''}`
}
