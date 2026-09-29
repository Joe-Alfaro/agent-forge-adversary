import { describe, expect, it } from 'vitest'

import {
  canRecheckTonight,
  type ExploitStatus,
  nextStatuses,
  sortForTriage,
  type TicketRow,
} from '../tickets.js'

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

describe('nextStatuses', () => {
  it('follows the open → in_progress → fixed → verified workflow', () => {
    expect(nextStatuses('open')).toContain('in_progress')
    expect(nextStatuses('in_progress')).toContain('fixed')
    expect(nextStatuses('fixed')).toContain('verified')
  })

  it('lets a verified ticket regress and a regressed ticket be picked up again', () => {
    expect(nextStatuses('verified')).toEqual(['regressed'])
    expect(nextStatuses('regressed')).toContain('in_progress')
  })

  it('reopens tickets that were dismissed', () => {
    expect(nextStatuses('false_positive')).toEqual(['open'])
    expect(nextStatuses('accepted_risk')).toEqual(['open'])
  })

  it('never offers the current status as a transition', () => {
    const all: ExploitStatus[] = [
      'open',
      'in_progress',
      'fixed',
      'verified',
      'false_positive',
      'accepted_risk',
      'regressed',
    ]
    all.forEach((status) => expect(nextStatuses(status)).not.toContain(status))
  })
})
