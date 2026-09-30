import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { resilience } from '../../lib/fixtures.js'
import type { ResilienceTrend } from '../../lib/resilience.js'
import { ResilienceChart } from '../ResilienceChart.js'

afterEach(cleanup)

/** The deployed shape: one version, seven categories, each with its own rubric. */
const singleVersion: ResilienceTrend = {
  versions: ['copilot@c1f011e'],
  points: [
    'data_exfiltration@e1fa80ca',
    'denial_of_service@7c2d11aa',
    'identity_role_exploitation@1b2c3d4e',
    'misinformation@5f6a7b8c',
    'prompt_injection@90ab44cd',
    'state_corruption@0d1e2f3a',
    'tool_misuse@4b5c6d7e',
  ].map((rubricVersion) => ({ targetVersion: 'copilot@c1f011e', rubricVersion, novelAttempts: 1, confirmed: 0 })),
}

function bodyRows() {
  const table = screen.getByRole('table', { name: 'Confirmed exploits per 100 novel attempts, by target version' })
  const [, body] = within(table).getAllByRole('rowgroup')
  return within(body as HTMLElement).getAllByRole('row')
}

describe('ResilienceChart', () => {
  it('draws one line per version, joined only where the rubrics did not change', () => {
    const { container } = render(<ResilienceChart trend={resilience} />)
    const segments = Array.from(container.querySelectorAll('[data-segment]')).map((path) =>
      path.getAttribute('data-segment'),
    )
    expect(segments).toEqual(['copilot@1.2.0→copilot@1.3.0', 'copilot@1.3.2→copilot@1.4.0'])
    expect(container.querySelectorAll('.trend-point')).toHaveLength(4)
  })

  it('marks the one real rubric change and names the category', () => {
    render(<ResilienceChart trend={resilience} />)
    expect(screen.getAllByText('Rubric changed')).toHaveLength(1)
    expect(
      screen.getByText(
        'The prompt injection rubric changed at copilot@1.3.2, so that version is not joined to copilot@1.3.0 (KEY_METRICS M4).',
      ),
    ).toBeTruthy()
  })

  it('has no per-rubric legend: the line is the version trend', () => {
    render(<ResilienceChart trend={resilience} />)
    expect(screen.queryByRole('list', { name: 'Rubric versions' })).toBeNull()
  })

  it('shows every version in a table view', () => {
    render(<ResilienceChart trend={resilience} />)
    const rows = bodyRows()
    expect(rows).toHaveLength(4)
    expect(within(rows[3] as HTMLElement).getAllByRole('cell').map((cell) => cell.textContent)).toEqual([
      'copilot@1.4.0',
      '1,010',
      '19',
      '1.9',
      '3 categories',
    ])
  })

  it('shows the values for a version on hover or focus', () => {
    render(<ResilienceChart trend={resilience} />)
    fireEvent.focus(screen.getByLabelText(/^copilot@1\.3\.2:/))
    const tooltip = screen.getByRole('tooltip')
    expect(tooltip.textContent).toContain('copilot@1.3.2')
    expect(tooltip.textContent).toContain('1.5 per 100 (14 of 920)')
    expect(tooltip.textContent).toContain('prompt injection rubric changed')
  })

  it('reads cleanly with one version judged by seven per-category rubrics', () => {
    const { container } = render(<ResilienceChart trend={singleVersion} />)
    expect(screen.queryByText('Rubric changed')).toBeNull()
    expect(screen.queryByText(/starts at/)).toBeNull()
    expect(screen.queryByText(/Rubric data_exf/)).toBeNull()
    expect(container.querySelectorAll('.trend-point')).toHaveLength(1)
    expect(bodyRows()).toHaveLength(1)
    expect(screen.getByText('One target version so far; the trend appears once a second version is tested.')).toBeTruthy()
  })

  it('says so when there is nothing to plot', () => {
    render(<ResilienceChart trend={{ versions: ['copilot@1'], points: [] }} />)
    expect(screen.getByText('No judged novel attempts yet.')).toBeTruthy()
  })
})
