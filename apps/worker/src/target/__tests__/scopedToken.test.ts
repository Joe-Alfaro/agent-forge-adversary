import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import { mintScopedToken } from '../scopedToken.js'

const secret = 'test-secret-not-a-real-key'

describe('mintScopedToken', () => {
  it('produces the v1.<payload>.<signature> wire format the Co-Pilot verifies', () => {
    const token = mintScopedToken(secret, {
      userId: 7,
      pid: 42,
      sessionFingerprint: 'sess-1',
      ttlSeconds: 300,
      issuedAtMs: 1_800_000_000_000,
    })
    const parts = token.split('.')
    expect(parts).toHaveLength(3)
    expect(parts[0]).toBe('v1')

    // The signature must be HMAC-SHA256 over `v1.<payload>` — recomputed here
    // independently of the minting code, the way the Co-Pilot does.
    const expected = createHmac('sha256', secret).update(`v1.${parts[1]}`).digest('base64url')
    expect(parts[2]).toBe(expected)
  })

  it('embeds the claims with second-precision iat/exp', () => {
    const token = mintScopedToken(secret, {
      userId: 7,
      pid: 42,
      sessionFingerprint: 'sess-1',
      ttlSeconds: 300,
      issuedAtMs: 1_800_000_000_000,
    })
    const payload = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8'))
    expect(payload).toMatchObject({ v: 1, uid: 7, pid: 42, sfp: 'sess-1' })
    expect(payload.iat).toBe(1_800_000_000)
    expect(payload.exp).toBe(1_800_000_300)
  })

  it('rejects a non-positive pid', () => {
    expect(() =>
      mintScopedToken(secret, { userId: 1, pid: 0, sessionFingerprint: 's', ttlSeconds: 60, issuedAtMs: 0 }),
    ).toThrow()
  })
})
