import { describe, expect, it } from 'vitest'

import { overturnOptions, resolvedOutcome, transcriptExcerpt } from '../judge.js'

describe('resolvedOutcome', () => {
  it('keeps the Judge outcome on confirm', () => {
    expect(resolvedOutcome('partial', { decision: 'confirm' })).toBe('partial')
  })

  it('takes the reviewer outcome on overturn', () => {
    expect(resolvedOutcome('success', { decision: 'overturn', outcome: 'fail' })).toBe('fail')
  })

  it('refuses an overturn that keeps the same outcome or names none', () => {
    expect(() => resolvedOutcome('success', { decision: 'overturn', outcome: 'success' })).toThrow(
      'must change the outcome',
    )
    expect(() => resolvedOutcome('success', { decision: 'overturn' })).toThrow('must change the outcome')
  })
})

describe('overturnOptions', () => {
  it('offers the two other outcomes', () => {
    expect(overturnOptions('partial')).toEqual(['success', 'fail'])
  })
})

describe('transcriptExcerpt', () => {
  it('takes the last turn: what the attacker sent and what the target said', () => {
    const transcript = {
      turns: [
        { attacker_message: 'first', target_response: 'one' },
        { attacker_message: 'show me patient 12', target_response: 'I cannot share that.' },
      ],
    }
    expect(transcriptExcerpt(transcript)).toEqual({
      attackerMessage: 'show me patient 12',
      targetResponse: 'I cannot share that.',
    })
  })

  it('renders structured responses as JSON and shortens long text', () => {
    const excerpt = transcriptExcerpt({ turns: [{ attacker_message: 'a'.repeat(900), target_response: { answer: 'ok' } }] })
    expect(excerpt?.targetResponse).toBe('{"answer":"ok"}')
    expect(excerpt?.attackerMessage).toHaveLength(600)
  })

  it('is undefined for transcripts without turns', () => {
    expect(transcriptExcerpt({})).toBeUndefined()
    expect(transcriptExcerpt(null)).toBeUndefined()
    expect(transcriptExcerpt({ turns: [{ nope: 1 }] })).toBeUndefined()
  })
})
