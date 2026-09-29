import { cleanup, fireEvent, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { QueueItem } from '../../lib/models.js'
import { planTonight } from '../../lib/queue.js'
import { renderWithProviders } from '../../test-utils.js'
import { QueueTable } from '../QueueTable.js'

const items: QueueItem[] = [
  {
    id: 'req-1',
    kind: 'rerun',
    exploitId: 'AF-2026-0004',
    requestedBy: 'dana',
    requestedAt: '2026-09-29T08:12:00Z',
    source: 'ui',
    estimatedCostUsd: 6,
  },
  {
    id: 'req-2',
    kind: 'focus',
    category: 'data_exfiltration',
    requestedBy: 'sam',
    requestedAt: '2026-09-29T08:20:00Z',
    source: 'chat',
    estimatedCostUsd: 6,
  },
]

async function renderQueue() {
  const onRemove = vi.fn()
  const onMove = vi.fn()
  renderWithProviders(<QueueTable plan={planTonight(items, 10)} onRemove={onRemove} onMove={onMove} />)
  await screen.findByRole('table')
  const [, body] = screen.getAllByRole('rowgroup')
  if (!body) {
    throw new Error('queue table has no body')
  }
  return { onRemove, onMove, rows: within(body).getAllByRole('row') }
}

afterEach(cleanup)

describe('QueueTable', () => {
  it('shows each request in order and marks what the envelope will cut', async () => {
    const { rows } = await renderQueue()
    const [first, second] = rows
    if (!first || !second) {
      throw new Error('expected two rows')
    }
    expect(within(first).getByRole('link', { name: 'AF-2026-0004' })).toBeTruthy()
    expect(within(first).queryByText('Will be cut')).toBeNull()
    expect(within(second).getByText('data exfiltration')).toBeTruthy()
    expect(within(second).getByText('Will be cut')).toBeTruthy()
  })

  it('reorders and removes requests through the callbacks', async () => {
    const { onRemove, onMove } = await renderQueue()
    fireEvent.click(screen.getByRole('button', { name: 'Move request 2 up' }))
    expect(onMove).toHaveBeenCalledWith('req-2', 'up')
    fireEvent.click(screen.getByRole('button', { name: 'Remove request 1' }))
    expect(onRemove).toHaveBeenCalledWith('req-1')
  })

  it('disables moves past either end of the queue', async () => {
    await renderQueue()
    expect(screen.getByRole('button', { name: 'Move request 1 up' })).toHaveProperty('disabled', true)
    expect(screen.getByRole('button', { name: 'Move request 2 down' })).toHaveProperty('disabled', true)
  })
})
