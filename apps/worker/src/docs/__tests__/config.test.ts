import { describe, expect, it } from 'vitest'

import { readDocsConfig } from '../config.js'

describe('readDocsConfig', () => {
  it('uses the model when ANTHROPIC_API_KEY_DOCS is set', () => {
    expect(readDocsConfig({ ANTHROPIC_API_KEY_DOCS: 'k' })).toEqual({ mode: 'llm', apiKey: 'k', maxReports: 10 })
  })

  it('runs offline when DOCS_MODE=offline, even with a key', () => {
    expect(readDocsConfig({ DOCS_MODE: 'offline', ANTHROPIC_API_KEY_DOCS: 'k' })).toEqual({ mode: 'offline', maxReports: 10 })
  })

  it('refuses to fall back silently when the key is missing', () => {
    expect(() => readDocsConfig({})).toThrow(/ANTHROPIC_API_KEY_DOCS/)
  })

  it('reads DOCS_MAX_REPORTS as a positive integer', () => {
    expect(readDocsConfig({ DOCS_MODE: 'offline', DOCS_MAX_REPORTS: '3' }).maxReports).toBe(3)
    expect(() => readDocsConfig({ DOCS_MODE: 'offline', DOCS_MAX_REPORTS: '0' })).toThrow(/DOCS_MAX_REPORTS/)
  })

  it('rejects an unknown DOCS_MODE', () => {
    expect(() => readDocsConfig({ DOCS_MODE: 'cheap' })).toThrow(/DOCS_MODE/)
  })
})
