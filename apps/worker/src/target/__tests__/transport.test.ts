import { describe, expect, it } from 'vitest'

import { Allowlist } from '../allowlist.js'
import { TargetUnreachable } from '../errors.js'
import { HttpTransport, type TransportPolicy } from '../transport.js'
import { FakeClock, stubFetch } from './fakes.js'

const allow = new Allowlist(['https://copilot-evidence-production.up.railway.app/'])
const url = 'https://copilot-evidence-production.up.railway.app/answer'

const fastPolicy: TransportPolicy = {
  rpm: 1000,
  concurrency: 4,
  maxRetries: 5,
  backoffBaseMs: 500,
  backoffMaxMs: 30_000,
}

describe('HttpTransport', () => {
  it('returns a non-429 response without retrying', async () => {
    const clock = new FakeClock()
    const { fetch, requests } = stubFetch([{ status: 200, body: { ok: true } }])
    const transport = new HttpTransport(allow, fetch, clock, fastPolicy)

    const result = await transport.request(url, { method: 'POST', headers: {} })
    expect(result.status).toBe(200)
    expect(JSON.parse(result.body)).toEqual({ ok: true })
    expect(requests).toHaveLength(1)
    expect(clock.sleeps).toHaveLength(0)
  })

  it('retries on 429 with exponential backoff then succeeds', async () => {
    const clock = new FakeClock()
    const { fetch, requests } = stubFetch([
      { status: 429, body: 'slow down' },
      { status: 429, body: 'slow down' },
      { status: 200, body: { ok: true } },
    ])
    const transport = new HttpTransport(allow, fetch, clock, fastPolicy)

    const result = await transport.request(url, { method: 'POST', headers: {} })
    expect(result.status).toBe(200)
    expect(requests).toHaveLength(3)
    // Two backoffs: 500*2^0 and 500*2^1, each jittered by random()=0.5 -> *0.75.
    expect(clock.sleeps).toEqual([375, 750])
  })

  it('honours Retry-After over exponential backoff', async () => {
    const clock = new FakeClock()
    const { fetch } = stubFetch([
      { status: 429, body: '', headers: { 'retry-after': '2' } },
      { status: 200, body: { ok: true } },
    ])
    const transport = new HttpTransport(allow, fetch, clock, fastPolicy)

    await transport.request(url, { method: 'POST', headers: {} })
    expect(clock.sleeps).toEqual([2000])
  })

  it('raises TargetUnreachable after the retry ceiling', async () => {
    const clock = new FakeClock()
    const { fetch } = stubFetch(Array.from({ length: 6 }, () => ({ status: 429, body: '' })))
    const transport = new HttpTransport(allow, fetch, clock, { ...fastPolicy, maxRetries: 5 })

    await expect(transport.request(url, { method: 'POST', headers: {} })).rejects.toBeInstanceOf(TargetUnreachable)
  })

  it('retries a thrown network error', async () => {
    const clock = new FakeClock()
    let calls = 0
    const fetch = async () => {
      calls += 1
      if (calls === 1) {
        throw new Error('ECONNRESET')
      }
      return { status: 200, headers: { get: () => null }, text: async () => '{}' }
    }
    const transport = new HttpTransport(allow, fetch, clock, fastPolicy)

    const result = await transport.request(url, { method: 'GET', headers: {} })
    expect(result.status).toBe(200)
    expect(calls).toBe(2)
  })
})
