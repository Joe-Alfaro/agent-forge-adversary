import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { resilience } from '../../lib/fixtures.js'
import { ResilienceChart } from '../ResilienceChart.js'

afterEach(cleanup)

describe('ResilienceChart', () => {
  it('draws lines only between consecutive versions judged by the same rubric', () => {
    const { container } = render(<ResilienceChart trend={resilience} />)
    const segments = Array.from(container.querySelectorAll('[data-segment]')).map((path) =>
      path.getAttribute('data-segment'),
    )
    expect(segments).toEqual([
      '4be1c09f:copilot@1.2.0→copilot@1.3.0',
      '4be1c09f:copilot@1.3.0→copilot@1.3.2',
      '9c07e3b5:copilot@1.3.2→copilot@1.4.0',
    ])
  })

  it('names the rubric change and says why the line breaks', () => {
    render(<ResilienceChart trend={resilience} />)
    expect(screen.getByText('Rubric changed')).toBeTruthy()
    expect(screen.getByText(/Rubric 9c07e3b5 starts at copilot@1\.3\.2/)).toBeTruthy()
  })

  it('has a legend entry per rubric', () => {
    render(<ResilienceChart trend={resilience} />)
    const legend = screen.getByRole('list', { name: 'Rubric versions' })
    expect(within(legend).getAllByRole('listitem').map((item) => item.textContent)).toEqual([
      'Rubric 4be1c09f',
      'Rubric 9c07e3b5',
    ])
  })

  it('shows every point in a table view', () => {
    render(<ResilienceChart trend={resilience} />)
    const table = screen.getByRole('table', { name: 'Confirmed exploits per 100 novel attempts, by version and rubric' })
    const [, body] = within(table).getAllByRole('rowgroup')
    const rows = within(body as HTMLElement).getAllByRole('row')
    expect(rows).toHaveLength(5)
    expect(within(rows[4] as HTMLElement).getAllByRole('cell').map((cell) => cell.textContent)).toEqual([
      'copilot@1.4.0',
      '9c07e3b5',
      '1,010',
      '19',
      '1.9',
    ])
  })

  it('shows the values for a version on hover or focus', () => {
    render(<ResilienceChart trend={resilience} />)
    fireEvent.focus(screen.getByLabelText(/^copilot@1\.3\.2:/))
    const tooltip = screen.getByRole('tooltip')
    expect(tooltip.textContent).toContain('copilot@1.3.2')
    expect(tooltip.textContent).toContain('1.7 per 100 (2 of 120)')
    expect(tooltip.textContent).toContain('1.5 per 100 (12 of 800)')
  })

  it('says so when there is nothing to plot', () => {
    render(<ResilienceChart trend={{ versions: ['copilot@1'], points: [] }} />)
    expect(screen.getByText('No judged novel attempts yet.')).toBeTruthy()
  })
})
