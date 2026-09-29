import { cleanup, fireEvent, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { fetchQueue, fetchTicket, resetStore } from '../../lib/data-source.js'
import { renderWithProviders } from '../../test-utils.js'
import { RecheckTonight } from '../RecheckTonight.js'

async function renderFor(id: string) {
  const ticket = await fetchTicket(id)
  if (!ticket) {
    throw new Error(`missing fixture ${id}`)
  }
  renderWithProviders(<RecheckTonight ticket={ticket} />)
  await screen.findByRole('heading', { name: 'Re-check tonight' })
}

beforeEach(resetStore)
afterEach(cleanup)

describe('RecheckTonight', () => {
  it('queues a RerunRequest with the operator’s reason', async () => {
    await renderFor('AF-2026-0007')
    fireEvent.change(await screen.findByLabelText('Reason (optional)'), {
      target: { value: 'focus on exfiltration' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Re-check tonight' }))
    expect(await screen.findByText('Queued for tonight.')).toBeTruthy()
    const queued = (await fetchQueue()).items.find((item) => item.exploitId === 'AF-2026-0007')
    expect(queued).toMatchObject({ kind: 'rerun', source: 'ui', reason: 'focus on exfiltration' })
  })

  it('shows tickets that are already queued instead of offering the button', async () => {
    await renderFor('AF-2026-0004')
    expect(await screen.findByText('Already queued for tonight.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Re-check tonight' })).toBeNull()
  })

  it('explains why resolved tickets cannot be re-checked', async () => {
    await renderFor('AF-2026-0006')
    expect(await screen.findByText('Verified tickets are not re-checked.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Re-check tonight' })).toBeNull()
  })
})
