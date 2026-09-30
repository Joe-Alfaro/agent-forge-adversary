import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { queueQuery } from '../../lib/queries.js'
import {
  advanceTestClock,
  fetchQueue,
  fetchRun,
  removeQueueItem,
  resetTestData,
  setRunNowEnabled,
  setScheduledPlan,
} from '../../test-data-source.js'
import { renderReady } from '../../test-utils.js'
import { QueueView } from '../QueueView.js'

vi.mock('../../lib/data-source.js', () => import('../../test-data-source.js'))

async function renderQueue(onRunScheduled = vi.fn()) {
  await renderReady(<QueueView pollMs={20} onRunScheduled={onRunScheduled} />, (client) =>
    client.ensureQueryData(queueQuery),
  )
  await screen.findByRole('table', { name: "Tonight's queue in run order" })
  return onRunScheduled
}

/** Scheduled run-nows are not in run history until they start, so look the first one up by id. */
async function scheduledRunNows() {
  const run = await fetchRun('run-now-1')
  return run ? [run.id] : []
}

beforeEach(resetTestData)
afterEach(cleanup)

describe('QueueView plan', () => {
  it('summarizes the whole plan against the envelope and says who planned it', async () => {
    await renderQueue()
    expect(screen.getByText(/12 of 14 items will run for \$24\.40 of the \$25\.00 envelope; 2 cut\./)).toBeTruthy()
    expect(screen.getByText(/Planned by the Orchestrator at .* for copilot@1\.4\.0/)).toBeTruthy()
    expect(screen.getByText('Operator skipped category denial_of_service tonight.')).toBeTruthy()
  })

  it('renders operator requests first, then the plan’s regressions and coverage campaigns in plan order', async () => {
    await renderQueue()
    const [, body] = screen.getAllByRole('rowgroup')
    const kinds = within(body as HTMLElement)
      .getAllByRole('row')
      .map((row) => within(row).getAllByRole('cell')[1]?.textContent)
    expect(kinds).toEqual([
      'rerun',
      'focus',
      'rerun',
      'skip',
      'focus',
      'regression',
      'regression',
      ...Array.from({ length: 7 }, () => 'coverage campaign'),
    ])
  })

  it('says when the Orchestrator has not planned tonight yet', async () => {
    setScheduledPlan(null)
    await renderQueue()
    expect(screen.getByText('The Orchestrator has not planned tonight yet; showing operator requests only.')).toBeTruthy()
  })
})

describe('QueueView run now', () => {
  it('shows the whole-plan estimate, item count, and envelope before anything runs', async () => {
    await renderQueue()
    fireEvent.click(screen.getByRole('button', { name: 'Run queue now' }))
    const dialog = screen.getByRole('dialog', { name: 'Run the whole queue now?' })
    // 5 operator requests ($1.50) + 2 regressions ($0.60) + 7 coverage campaigns ($29.70).
    expect(dialog.textContent).toContain('14 items')
    expect(dialog.textContent).toContain('$31.80')
    expect(dialog.textContent).toContain('$25.00')
    expect(within(dialog).getByText(/exceeds tonight’s \$25\.00 envelope by \$6\.80/)).toBeTruthy()
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
    expect(dialog.textContent).toContain('1 item')
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
    fireEvent.click(screen.getByRole('button', { name: 'Confirm: run now for $31.80' }))
    await screen.findByText('Run run-now-1 is scheduled.')
    fireEvent.click(screen.getByRole('button', { name: 'Run request 2 now' }))
    fireEvent.click(screen.getByRole('button', { name: /^Confirm: run now/ }))
    expect((await screen.findByRole('alert')).textContent).toContain('already scheduled or running')
  })

  it('disables both Run-now buttons, with a note, when the server has run now turned off', async () => {
    setRunNowEnabled(false)
    await renderQueue()
    expect(screen.getByRole('button', { name: 'Run queue now' })).toHaveProperty('disabled', true)
    expect(screen.getByRole('button', { name: 'Run request 1 now' })).toHaveProperty('disabled', true)
    expect(screen.getByText('Run now executes in the local demo; it is turned off on this deployment.')).toBeTruthy()
  })

  it('disables Run queue now when nothing is queued', async () => {
    await Promise.all((await fetchQueue()).items.map((entry) => removeQueueItem(entry.id)))
    await renderReady(<QueueView pollMs={20} />, (client) => client.ensureQueryData(queueQuery))
    const button = await screen.findByRole('button', { name: 'Run queue now' })
    expect(button).toHaveProperty('disabled', true)
  })
})
