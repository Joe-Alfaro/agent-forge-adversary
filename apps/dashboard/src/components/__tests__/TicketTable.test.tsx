import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import type { TicketRow } from '../../lib/tickets.js'
import { TicketTable } from '../TicketTable.js'

const base: Omit<TicketRow, 'id' | 'severity' | 'status'> = {
  category: 'prompt_injection',
  owaspIds: ['LLM01'],
  confidence: 0.92,
  familySize: 4,
  discoveredVersion: 'copilot@1.4.0',
}

const rows: TicketRow[] = [
  { ...base, id: 'AF-2026-0003', severity: 'low', status: 'open' },
  { ...base, id: 'AF-2026-0002', severity: 'critical', status: 'verified' },
  {
    ...base,
    id: 'AF-2026-0001',
    severity: 'critical',
    status: 'in_progress',
    category: 'data_exfiltration',
    owaspIds: ['LLM02', 'A01'],
    assignee: 'dana',
  },
]

function bodyRows() {
  const [, body] = screen.getAllByRole('rowgroup')
  if (!body) {
    throw new Error('ticket table has no body')
  }
  return within(body).getAllByRole('row')
}

afterEach(cleanup)

describe('TicketTable', () => {
  it('renders the Section 15.1 columns', () => {
    render(<TicketTable rows={rows} />)
    const headers = screen.getAllByRole('columnheader').map((cell) => cell.textContent)
    expect(headers).toEqual([
      'ID',
      'Severity',
      'Category',
      'OWASP',
      'Status',
      'Assignee',
      'Confidence',
      'Family size',
    ])
  })

  it('orders rows for triage: open criticals first, resolved last', () => {
    render(<TicketTable rows={rows} />)
    const ids = bodyRows().map((row) => within(row).getAllByRole('cell')[0]?.textContent)
    expect(ids).toEqual(['AF-2026-0001', 'AF-2026-0003', 'AF-2026-0002'])
  })

  it('formats OWASP ids, status, assignee, and confidence for reading', () => {
    render(<TicketTable rows={rows} />)
    const [first, second] = bodyRows()
    if (!first || !second) {
      throw new Error('expected two rows')
    }
    expect(within(first).getByText('LLM02, A01')).toBeTruthy()
    expect(within(first).getByText('in progress')).toBeTruthy()
    expect(within(first).getByText('dana')).toBeTruthy()
    expect(within(first).getByText('92%')).toBeTruthy()
    expect(within(second).getByText('Unassigned')).toBeTruthy()
  })

  it('shows an empty state when there are no findings', () => {
    render(<TicketTable rows={[]} />)
    expect(screen.getByText('No findings yet.')).toBeTruthy()
  })
})
