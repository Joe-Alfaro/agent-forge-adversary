import { describe, expect, it } from 'vitest'

import { sortForTriage, canRecheckTonight, type TicketRow } from '../tickets.js'

const base: Omit<TicketRow, 'id' | 'severity' | 'status'> = {
  category: 'prompt_injection',
  owaspIds: ['LLM01'],
  confidence: 0.9,
  familySize: 3,
  discoveredVersion: 'copilot@1',
}

describe('sortForTriage', () => {
  it('puts open criticals above resolved and lower severities', () => {
    const rows: TicketRow[] = [
      { ...base, id: 'AF-3', severity: 'low', status: 'open' },
      { ...base, id: 'AF-2', severity: 'critical', status: 'verified' },
      { ...base, id: 'AF-1', severity: 'critical', status: 'open' },
    ]
    expect(sortForTriage(rows).map((row) => row.id)).toEqual(['AF-1', 'AF-3', 'AF-2'])
  })
})

describe('canRecheckTonight', () => {
  it('allows re-checking open and regressed tickets', () => {
    expect(canRecheckTonight('open')).toBe(true)
    expect(canRecheckTonight('regressed')).toBe(true)
  })

  it('blocks re-checking closed tickets', () => {
    expect(canRecheckTonight('verified')).toBe(false)
    expect(canRecheckTonight('accepted_risk')).toBe(false)
  })
})
