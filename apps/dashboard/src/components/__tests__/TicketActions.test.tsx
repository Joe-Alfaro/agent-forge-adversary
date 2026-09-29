import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { fetchTicket, resetStore } from '../../lib/data-source.js'
import type { TicketRow } from '../../lib/tickets.js'
import { renderWithProviders } from '../../test-utils.js'
import { TicketActions } from '../TicketActions.js'

async function renderFor(id: string) {
  const ticket = await fetchTicket(id)
  if (!ticket) {
    throw new Error(`missing fixture ${id}`)
  }
  renderWithProviders(<TicketActions ticket={ticket as TicketRow} />)
  await screen.findByRole('form', { name: 'Update ticket' })
}

beforeEach(resetStore)
afterEach(cleanup)

describe('TicketActions', () => {
  it('offers only the current status and its allowed transitions', async () => {
    await renderFor('AF-2026-0002')
    const select = screen.getByLabelText('Status')
    const options = within(select).getAllByRole('option').map((option) => option.getAttribute('value'))
    expect(options).toEqual(['open', 'in_progress', 'false_positive', 'accepted_risk'])
  })

  it('saves a status change and assignee to the ticket', async () => {
    await renderFor('AF-2026-0002')
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'in_progress' } })
    fireEvent.change(screen.getByLabelText('Assignee'), { target: { value: 'sam' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByRole('status')).toHaveProperty('textContent', 'Saved.')
    const saved = await fetchTicket('AF-2026-0002')
    expect(saved).toMatchObject({ status: 'in_progress', assignee: 'sam' })
  })

  it('keeps Save disabled until something changes', async () => {
    await renderFor('AF-2026-0002')
    const save = screen.getByRole('button', { name: 'Save' })
    expect(save).toHaveProperty('disabled', true)
    fireEvent.change(screen.getByLabelText('Assignee'), { target: { value: 'sam' } })
    await waitFor(() => expect(save).toHaveProperty('disabled', false))
  })
})
