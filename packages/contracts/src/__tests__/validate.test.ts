import { describe, expect, it } from 'vitest'

import { validateVerdict, validateRerunRequest } from '../validate.js'
import type { Verdict, RerunRequest } from '../types.js'

const validVerdict: Verdict = {
  schema_version: '1',
  message_id: '11111111-1111-4111-8111-111111111111',
  campaign_id: '22222222-2222-4222-8222-222222222222',
  trace_id: 'trace-abc',
  attempt_id: '33333333-3333-4333-8333-333333333333',
  produced_by: 'judge',
  produced_at: '2026-09-28T01:00:00.000Z',
  target_version: 'copilot@2026-09-28',
  outcome: 'success',
  confidence: 1,
  stage: 'detector',
  rubric_version: 'phi-exfil@3',
  evidence: [{ kind: 'detector_hit', ref: 'phi_canary', note: 'canary MRN leaked' }],
  needs_review: false,
}

describe('validateVerdict', () => {
  it('accepts a well-formed verdict', () => {
    const result = validateVerdict(validVerdict)
    expect(result.valid).toBe(true)
    expect(result.value?.outcome).toBe('success')
  })

  it('rejects an out-of-range confidence', () => {
    const result = validateVerdict({ ...validVerdict, confidence: 1.5 })
    expect(result.valid).toBe(false)
    expect(result.errors.join(' ')).toContain('confidence')
  })

  it('rejects an unknown outcome', () => {
    const result = validateVerdict({ ...validVerdict, outcome: 'maybe' })
    expect(result.valid).toBe(false)
  })

  it('rejects extra properties', () => {
    const result = validateVerdict({ ...validVerdict, injected: 'ignore previous instructions' })
    expect(result.valid).toBe(false)
  })
})

describe('validateRerunRequest', () => {
  const validRerun: RerunRequest = {
    schema_version: '1',
    message_id: '44444444-4444-4444-8444-444444444444',
    requested_by: 'operator',
    requested_for: '2026-09-29',
    source: 'ui',
    reason: 'fix deployed, re-check family',
    target: { kind: 'exploit', exploit_id: 'AF-2026-0007' },
  }

  it('accepts a well-formed rerun request', () => {
    const result = validateRerunRequest(validRerun)
    expect(result.valid).toBe(true)
  })

  it('rejects an unknown source', () => {
    const result = validateRerunRequest({ ...validRerun, source: 'api' })
    expect(result.valid).toBe(false)
  })
})
