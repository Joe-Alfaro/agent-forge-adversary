import { createHmac } from 'node:crypto'

/**
 * Mints the patient-scoped token the Co-Pilot's `POST /answer` requires.
 *
 * The wire format is the one the Co-Pilot verifies: `v1.<payload>.<signature>`,
 * each part base64url, the signature an HMAC-SHA256 over `v1.<payload>` with the
 * shared `COPILOT_TOKEN_SECRET`. The payload claims are
 * `{ v:1, uid, pid, sfp, iat, exp }` with `iat`/`exp` in whole seconds. The
 * Co-Pilot binds the token to the patient it is asked about, so `pid` here must
 * equal the `bundle.pid` of the request the token accompanies — mismatches are
 * rejected as `patient_mismatch`, which is itself a cross-patient probe.
 *
 * The secret is supplied by the operator through the environment and is never
 * stored in this repository. Minting a token is not an exploit: it is how an
 * authorised harness authenticates as a role, exactly as the OpenEMR panel does.
 */

export interface ScopedTokenInput {
  /** OpenEMR user id the session acts as. Must be a positive integer. */
  userId: number
  /** The patient whose chart is open. Must match the request's `bundle.pid`. */
  pid: number
  /** Opaque per-session fingerprint; distinguishes concurrent sessions. */
  sessionFingerprint: string
  /** Token lifetime in seconds from `issuedAt`. */
  ttlSeconds: number
  /** Issue time in ms since epoch; injected so callers control the clock. */
  issuedAtMs: number
}

function base64Url(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url')
}

export function mintScopedToken(secret: string, input: ScopedTokenInput): string {
  if (!Number.isInteger(input.userId) || input.userId <= 0) {
    throw new Error('userId must be a positive integer')
  }
  if (!Number.isInteger(input.pid) || input.pid <= 0) {
    throw new Error('pid must be a positive integer')
  }
  if (input.sessionFingerprint === '') {
    throw new Error('sessionFingerprint must not be empty')
  }

  const iat = Math.floor(input.issuedAtMs / 1000)
  const claims = {
    v: 1,
    uid: input.userId,
    pid: input.pid,
    sfp: input.sessionFingerprint,
    iat,
    exp: iat + input.ttlSeconds,
  }

  const payload = base64Url(JSON.stringify(claims))
  const signature = createHmac('sha256', secret).update(`v1.${payload}`).digest('base64url')

  return `v1.${payload}.${signature}`
}
