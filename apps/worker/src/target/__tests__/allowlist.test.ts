import { describe, expect, it } from 'vitest'

import { Allowlist } from '../allowlist.js'
import { TargetNotAllowlisted } from '../errors.js'

const allow = new Allowlist([
  'https://copilot-evidence-production.up.railway.app/',
  'https://openemr-production-ef61.up.railway.app/',
])

describe('Allowlist', () => {
  it('permits an allowlisted origin regardless of path or query', () => {
    expect(allow.permits('https://copilot-evidence-production.up.railway.app/answer?x=1')).toBe(true)
  })

  it('denies a host that is not on the list', () => {
    expect(allow.permits('https://evil.example.com/answer')).toBe(false)
  })

  it('denies a matching host on a different scheme or port', () => {
    expect(allow.permits('http://copilot-evidence-production.up.railway.app/answer')).toBe(false)
    expect(allow.permits('https://copilot-evidence-production.up.railway.app:8443/answer')).toBe(false)
  })

  it('denies a malformed url', () => {
    expect(allow.permits('not a url')).toBe(false)
  })

  it('assert throws TargetNotAllowlisted for a denied url', () => {
    expect(() => allow.assert('https://evil.example.com')).toThrow(TargetNotAllowlisted)
  })
})
