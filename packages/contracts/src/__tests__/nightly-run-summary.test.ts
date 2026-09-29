import { describe, expect, it } from 'vitest'

import { validateNightlyRunSummary } from '../validate.js'
import type { NightlyRunSummary } from '../types.js'

const valid: NightlyRunSummary = {
  target_version: 'copilot@c1f011e',
  headline: '2 new findings, 1 regression, budget held',
  new_tickets: ['AF-2026-0007'],
  regressions: ['AF-2026-0003'],
  verified_fixes: ['AF-2026-0001'],
  queue: { ran: 12, cut: 3 },
  notes: ['prompt_injection campaign halted on novelty floor'],
  trace_url: 'https://langfuse.example/trace/abc',
  generated_at: '2026-09-29T04:12:00.000Z',
}

describe('validateNightlyRunSummary', () => {
  it('accepts a well-formed summary', () => {
    const result = validateNightlyRunSummary(valid)
    expect(result.valid).toBe(true)
    expect(result.value?.queue.ran).toBe(12)
  })

  it('accepts a summary without the optional trace_url', () => {
    const { trace_url: _omit, ...withoutTrace } = valid
    expect(validateNightlyRunSummary(withoutTrace).valid).toBe(true)
  })

  it('tolerates unknown additional properties (forward compatibility)', () => {
    const result = validateNightlyRunSummary({ ...valid, spend_usd: 1.42, queue: { ...valid.queue, skipped: 1 } })
    expect(result.valid).toBe(true)
  })

  it('rejects a summary missing a required field', () => {
    const { headline: _omit, ...missing } = valid
    expect(validateNightlyRunSummary(missing).valid).toBe(false)
  })

  it('rejects a queue missing ran/cut', () => {
    const result = validateNightlyRunSummary({ ...valid, queue: { ran: 1 } })
    expect(result.valid).toBe(false)
  })

  it('rejects a non-date generated_at', () => {
    const result = validateNightlyRunSummary({ ...valid, generated_at: 'last night' })
    expect(result.valid).toBe(false)
  })
})
