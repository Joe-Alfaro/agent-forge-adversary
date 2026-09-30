import { cleanup, fireEvent, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { decideApproval, fetchApprovals, resetTestData } from '../../test-data-source.js'
import { renderWithProviders } from '../../test-utils.js'
import { ApprovalsQueue } from '../ApprovalsQueue.js'

vi.mock('../../lib/data-source.js', () => import('../../test-data-source.js'))

async function bodyRows() {
  const table = await screen.findByRole('table', { name: 'Reports waiting for a publish decision' })
  const [, body] = within(table).getAllByRole('rowgroup')
  if (!body) {
    throw new Error('approvals table has no body')
  }
  return within(body).getAllByRole('row')
}

beforeEach(resetTestData)
afterEach(cleanup)

describe('ApprovalsQueue', () => {
  it('lists the drafts waiting at a gate, operator-gated first', async () => {
    renderWithProviders(<ApprovalsQueue />)
    const rows = await bodyRows()
    expect(rows.map((row) => within(row).getAllByRole('cell')[0]?.textContent)).toEqual([
      'AF-2026-0002',
      'AF-2026-0004',
      'AF-2026-0007',
    ])
    expect(within(rows[0] as HTMLElement).getByText('G4: needs approval')).toBeTruthy()
    expect(within(rows[2] as HTMLElement).getByText(/G5: auto-publishes/)).toBeTruthy()
  })

  it('offers only approve and reject on a draft', async () => {
    renderWithProviders(<ApprovalsQueue />)
    const [first] = await bodyRows()
    const buttons = within(first as HTMLElement)
      .getAllByRole('button')
      .map((button) => button.textContent)
    expect(buttons).toEqual(['Approve and publish', 'Reject'])
  })

  it('approving publishes the report and takes it off the queue', async () => {
    renderWithProviders(<ApprovalsQueue />)
    await bodyRows()
    fireEvent.click(screen.getByRole('button', { name: 'Approve and publish AF-2026-0002 v1' }))
    expect(await screen.findByRole('status')).toHaveProperty('textContent', 'AF-2026-0002 v1 published.')
    expect((await bodyRows()).map((row) => within(row).getAllByRole('cell')[0]?.textContent)).not.toContain(
      'AF-2026-0002',
    )
    expect((await fetchApprovals()).map((item) => item.reportId)).not.toContain('rpt-0002-v1')
  })

  it('rejecting records the decision', async () => {
    renderWithProviders(<ApprovalsQueue />)
    await bodyRows()
    fireEvent.click(screen.getByRole('button', { name: 'Reject AF-2026-0007 v1' }))
    expect(await screen.findByRole('status')).toHaveProperty('textContent', 'AF-2026-0007 v1 rejected.')
    await expect(decideApproval('rpt-0007-v1', 'approve')).rejects.toThrow('rejected → published')
  })

  it('says so when nothing is waiting', async () => {
    await Promise.all((await fetchApprovals()).map((item) => decideApproval(item.reportId, 'reject')))
    renderWithProviders(<ApprovalsQueue />)
    expect(await screen.findByText('No reports are waiting for a decision.')).toBeTruthy()
  })
})
