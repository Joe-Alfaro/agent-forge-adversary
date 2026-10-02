import { cleanup, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import type { RunSummary } from '../../lib/models.js'
import { renderWithProviders } from '../../test-utils.js'
import { RunTable } from '../RunTable.js'

const base: Omit<RunSummary, 'id' | 'status' | 'hasMorningReport'> = {
  trigger: 'cron',
  startedAt: '2026-10-02T06:00:00.000Z',
  finishedAt: '2026-10-02T06:40:00.000Z',
  targetVersion: 'copilot@c1f011e',
  attempts: 84,
  verdicts: { success: 0, partial: 0, fail: 84 },
  newTickets: 0,
  regressions: 0,
  spendUsd: 0.36,
}

afterEach(cleanup)

describe('RunTable', () => {
  it('links the morning report of a run the spend cap stopped', async () => {
    renderWithProviders(<RunTable runs={[{ ...base, id: '4', status: 'aborted', hasMorningReport: true }]} />)
    const link = await screen.findByRole('link', { name: 'Morning report' })
    expect(link.getAttribute('href')).toBe('/reports/4')
    const [, body] = screen.getAllByRole('rowgroup')
    expect(within(body as HTMLElement).getByText('aborted')).toBeTruthy()
  })

  it('shows no report link for a run without one', async () => {
    renderWithProviders(<RunTable runs={[{ ...base, id: '5', status: 'failed', hasMorningReport: false }]} />)
    await screen.findByRole('table')
    expect(screen.queryByRole('link', { name: 'Morning report' })).toBeNull()
  })
})
