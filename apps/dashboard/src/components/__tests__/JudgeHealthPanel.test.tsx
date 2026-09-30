import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { JudgeHealthPanel } from '../JudgeHealthPanel.js'

afterEach(cleanup)

const health = {
  backlog: 4,
  oldestPendingAt: '2026-09-28T08:31:00.000Z',
  reviewed: 10,
  overturned: 2,
  byCategory: [
    { category: 'data_exfiltration', reviewed: 4, overturned: 1 },
    { category: 'tool_misuse', reviewed: 6, overturned: 1 },
  ],
  groundTruthLabels: 42,
}

describe('JudgeHealthPanel', () => {
  it('shows the backlog, its age, the overturn rate, and ground-truth labels', () => {
    render(<JudgeHealthPanel health={health} now={new Date('2026-09-29T20:31:00Z')} />)
    const stats = screen.getByRole('region', { name: 'Judge health' })
    const text = stats.textContent ?? ''
    expect(text).toContain('needs_review backlog4')
    expect(text).toContain('Oldest waiting36h')
    expect(text).toContain('Overturned by a human20%')
    expect(text).toContain('Ground-truth labels42')
  })

  it('shows agreement with human review per category', () => {
    render(<JudgeHealthPanel health={health} now={new Date('2026-09-29T20:31:00Z')} />)
    const table = screen.getByRole('table', { name: 'Judge agreement with human review, by category' })
    const [, body] = within(table).getAllByRole('rowgroup')
    const rows = within(body as HTMLElement).getAllByRole('row')
    expect(within(rows[0] as HTMLElement).getAllByRole('cell').map((cell) => cell.textContent)).toEqual([
      'data exfiltration',
      '4',
      '1',
      '75%',
    ])
  })

  it('handles an empty history', () => {
    render(
      <JudgeHealthPanel
        health={{ backlog: 0, reviewed: 0, overturned: 0, byCategory: [], groundTruthLabels: 0 }}
        now={new Date('2026-09-29T20:31:00Z')}
      />,
    )
    expect(screen.getByRole('region', { name: 'Judge health' }).textContent).toContain('Oldest waitingNone')
    expect(screen.getByText('No human reviews yet.')).toBeTruthy()
  })
})
