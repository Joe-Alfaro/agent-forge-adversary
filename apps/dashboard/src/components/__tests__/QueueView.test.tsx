import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  advanceTestClock,
  fetchQueue,
  fetchRun,
  fetchRuns,
  removeQueueItem,
  resetTestData,
} from '../../test-data-source.js'
import { renderWithProviders } from '../../test-utils.js'
import { QueueView } from '../QueueView.js'

vi.mock('../../lib/data-source.js', () => import('../../test-data-source.js'))

async function renderQueue(onRunScheduled = vi.fn()) {
  renderWithProviders(<QueueView pollMs={20} onRunScheduled={onRunScheduled} />)
  await screen.findByRole('table', { name: "Tonight's queue in run order" })
  return onRunScheduled
}

async function scheduledRunNows() {
  return (await fetchRuns()).filter((run) => run.id.startsWith('run-now-'))
}

beforeEach(resetTestData)
afterEach(cleanup)

describe('QueueView run now', () => {
  it('shows the whole-queue estimate, item count, and envelope before anything runs', async () => {
    await renderQueue()
    fireEvent.click(screen.getByRole('button', { name: 'Run queue now' }))
    const dialog = screen.getByRole('dialog', { name: 'Run the whole queue now?' })
    expect(dialog.textContent).toContain('5 requests')
    expect(dialog.textContent).toContain('$41.50')
    expect(dialog.textContent).toContain('$25.00')
    expect(within(dialog).getByText(/exceeds tonight’s \$25\.00 envelope by \$16\.50/)).toBeTruthy()
    expect(await scheduledRunNows()).toEqual([])
  })

  it('cancelling schedules nothing', async () => {
    await renderQueue()
    fireEvent.click(screen.getByRole('button', { name: 'Run queue now' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(await scheduledRunNows()).toEqual([])
  })

  it('closes on Escape', async () => {
    await renderQueue()
    fireEvent.click(screen.getByRole('button', { name: 'Run queue now' }))
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('estimates a single request from its own cost, with no warning inside the envelope', async () => {
    await renderQueue()
    fireEvent.click(screen.getByRole('button', { name: 'Run request 1 now' }))
    const dialog = screen.getByRole('dialog', { name: 'Run this request now?' })
    expect(dialog.textContent).toContain('1 request')
    expect(dialog.textContent).toContain('$0.60')
    expect(within(dialog).queryByText(/exceeds/)).toBeNull()
  })

  it('confirming schedules the run and follows it to its morning report', async () => {
    const onRunScheduled = await renderQueue()
    const [first] = (await fetchQueue()).items
    fireEvent.click(screen.getByRole('button', { name: 'Run request 1 now' }))
    fireEvent.click(screen.getByRole('button', { name: 'Confirm: run now for $0.60' }))

    expect(await screen.findByText('Run run-now-1 is scheduled.')).toBeTruthy()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(onRunScheduled).toHaveBeenCalledWith('run-now-1')
    expect((await fetchRun('run-now-1'))?.status).toBe('scheduled')

    advanceTestClock(2_000)
    expect(await screen.findByText('Run run-now-1 is running.')).toBeTruthy()
    await waitFor(async () => {
      const [, body] = screen.getAllByRole('rowgroup')
      expect(within(body as HTMLElement).queryByText(first?.reason ?? 'missing')).toBeNull()
    })

    advanceTestClock(10_000)
    const report = await screen.findByRole('link', { name: 'Open the morning report' })
    expect(report.getAttribute('href')).toBe('/reports/run-now-1')
    expect(screen.getByText('Run run-now-1 completed.')).toBeTruthy()
  })

  it('shows the server’s refusal, e.g. a second run while one is scheduled', async () => {
    await renderQueue()
    fireEvent.click(screen.getByRole('button', { name: 'Run queue now' }))
    fireEvent.click(screen.getByRole('button', { name: 'Confirm: run now for $41.50' }))
    await screen.findByText('Run run-now-1 is scheduled.')
    fireEvent.click(screen.getByRole('button', { name: 'Run request 2 now' }))
    fireEvent.click(screen.getByRole('button', { name: /^Confirm: run now/ }))
    expect((await screen.findByRole('alert')).textContent).toContain('already scheduled or running')
  })

  it('disables Run queue now when nothing is queued', async () => {
    await Promise.all((await fetchQueue()).items.map((entry) => removeQueueItem(entry.id)))
    renderWithProviders(<QueueView pollMs={20} />)
    const button = await screen.findByRole('button', { name: 'Run queue now' })
    expect(button).toHaveProperty('disabled', true)
  })
})
