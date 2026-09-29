import { describe, expect, it } from 'vitest'

import { createTracer, redactForTrace, resolveLangfuseConfig } from '../tracer.js'

describe('resolveLangfuseConfig', () => {
  it('is disabled when keys are absent', () => {
    expect(resolveLangfuseConfig({}).enabled).toBe(false)
  })

  it('is enabled when both keys are present', () => {
    const cfg = resolveLangfuseConfig({ LANGFUSE_PUBLIC_KEY: 'pk', LANGFUSE_SECRET_KEY: 'sk' })
    expect(cfg.enabled).toBe(true)
    expect(cfg.publicKey).toBe('pk')
  })

  it('prefers LANGFUSE_BASE_URL and falls back to LANGFUSE_BASEURL', () => {
    expect(resolveLangfuseConfig({ LANGFUSE_BASE_URL: 'https://new', LANGFUSE_BASEURL: 'https://old' }).baseUrl).toBe(
      'https://new',
    )
    expect(resolveLangfuseConfig({ LANGFUSE_BASEURL: 'https://old' }).baseUrl).toBe('https://old')
  })
})

describe('createTracer (offline / no keys)', () => {
  it('returns a disabled no-op tracer that never throws and yields a null url', async () => {
    const tracer = createTracer({})
    expect(tracer.enabled).toBe(false)
    const trace = tracer.startTrace({ name: 'run', buildCommit: 'c1f011e', rubricHash: 'phi@ab12' })
    expect(trace.url()).toBeNull()
    expect(() => trace.span({ name: 'target', input: { a: 1 } })).not.toThrow()
    expect(() => trace.generation({ name: 'judge', model: 'claude-sonnet-5-5', usage: { input: 1, output: 2 } })).not.toThrow()
    trace.update({ note: 'x' })
    await expect(tracer.flush()).resolves.toBeUndefined()
    await expect(tracer.shutdown()).resolves.toBeUndefined()
  })
})

describe('redactForTrace', () => {
  it('drops values under sensitive keys', () => {
    const out = redactForTrace({ token: 'v1.abc.def', question: 'hello', nested: { file_base64: 'QUJD' } })
    expect(out).toEqual({ token: '[REDACTED]', question: 'hello', nested: { file_base64: '[REDACTED]' } })
  })

  it('replaces configured secret substrings anywhere in strings', () => {
    const secret = 'super-secret-value-123'
    const out = redactForTrace({ msg: `prefix ${secret} suffix` }, [secret])
    expect(out).toEqual({ msg: 'prefix [REDACTED] suffix' })
  })

  it('walks arrays and leaves non-secret primitives intact', () => {
    expect(redactForTrace({ items: ['a', 2, true], n: 5 })).toEqual({ items: ['a', 2, true], n: 5 })
  })

  it('ignores secrets shorter than 8 chars to avoid over-redaction', () => {
    expect(redactForTrace({ msg: 'the cat sat' }, ['cat'])).toEqual({ msg: 'the cat sat' })
  })
})
