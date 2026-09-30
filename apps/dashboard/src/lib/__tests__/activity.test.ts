import { describe, expect, it } from 'vitest'

import { eventSummary, safeTraceUrl } from '../activity.js'

describe('safeTraceUrl', () => {
  it('accepts http and https trace links', () => {
    expect(safeTraceUrl('https://us.cloud.langfuse.com/trace/27ce2306')).toBe('https://us.cloud.langfuse.com/trace/27ce2306')
    expect(safeTraceUrl('http://langfuse.internal:3000/trace/abc')).toBe('http://langfuse.internal:3000/trace/abc')
  })

  it('refuses anything a link should not open', () => {
    expect(safeTraceUrl('javascript:alert(1)')).toBeUndefined()
    expect(safeTraceUrl('data:text/html,hi')).toBeUndefined()
    expect(safeTraceUrl('/relative/trace')).toBeUndefined()
    expect(safeTraceUrl(42)).toBeUndefined()
    expect(safeTraceUrl(undefined)).toBeUndefined()
  })
})

describe('eventSummary', () => {
  it('uses the first descriptive text field in the payload', () => {
    expect(eventSummary({ summary: 'Planned 4 campaigns', message: 'ignored' })).toBe('Planned 4 campaigns')
    expect(eventSummary({ message: 'Judged attempt 12' })).toBe('Judged attempt 12')
  })

  it('shortens long text', () => {
    const summary = eventSummary({ summary: 'x'.repeat(300) })
    expect(summary).toHaveLength(140)
    expect(summary?.endsWith('…')).toBe(true)
  })

  it('is undefined for payloads without text', () => {
    expect(eventSummary(null)).toBeUndefined()
    expect(eventSummary({ tokens: 12 })).toBeUndefined()
    expect(eventSummary('bare string')).toBeUndefined()
  })
})
