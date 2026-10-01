import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { queueQuery } from '../../lib/queries.js'
import {
  advanceTestClock,
  fetchQueue,
  fetchRun,
  removeQueueItem,
  resetTestData,
  setPlanningAvailable,
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

describe('QueueView plan tonight now', () => {
  it('regenerates the plan from the live queue and shows it at once', async () => {
    await removeQueueItem('req-102')
    await removeQueueItem('req-105')
    await renderQueue()
    // The preview was made while the focus requests were queued.
    expect(screen.getAllByText(/\+ focus/).length).toBeGreaterThan(0)
    fireEvent.click(screen.getByRole('button', { name: 'Plan tonight now' }))
    expect((await screen.findByRole('status')).textContent).toBe('Tonight’s plan regenerated at 2026-09-29 20:00 UTC.')
    expect(screen.queryAllByText(/\+ focus/)).toEqual([])
    expect(screen.getByText(/Planned by the Orchestrator at 2026-09-29 20:00 UTC/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Plan tonight now' })).toHaveProperty('disabled', false)
  })

  it('calls the planning function once, then refetches the queue', async () => {
    const dataSource = await import('../../lib/data-source.js')
    const plan = vi.spyOn(dataSource, 'planTonight')
    const { queryClient } = await renderReady(<QueueView pollMs={20} />, (client) => client.ensureQueryData(queueQuery))
    const updates = () => queryClient.getQueryState(queueQuery.queryKey)?.dataUpdateCount ?? 0
    const button = await screen.findByRole('button', { name: 'Plan tonight now' })
    expect(updates()).toBe(1)
    fireEvent.click(button)
    await screen.findByRole('status')
    expect(plan).toHaveBeenCalledTimes(1)
    // Once from the mutation's result, once from the refetch it triggers.
    await waitFor(() => expect(updates()).toBe(3))
    plan.mockRestore()
  })

  it('is disabled, with a note, where the Orchestrator’s planner is not connected', async () => {
    setPlanningAvailable(false)
    await renderQueue()
    expect(screen.getByRole('button', { name: 'Plan tonight now' })).toHaveProperty('disabled', true)
    expect(screen.getByText('Planning from the dashboard is not connected yet; run plan:preview from the worker.')).toBeTruthy()
  })
})

describe('QueueView nightly budget', () => {
  async function changeBudget(value: string) {
    fireEvent.click(screen.getByRole('button', { name: 'Change nightly budget' }))
    fireEvent.change(screen.getByLabelText('Nightly budget (USD)'), { target: { value } })
    fireEvent.click(screen.getByRole('button', { name: 'Save budget' }))
  }

  it('shows the current budget', async () => {
    await renderQueue()
    expect(screen.getByText('Nightly budget: $25.00')).toBeTruthy()
  })

  it('saves a new budget and recomputes run and cut against it at once', async () => {
    await renderQueue()
    await changeBudget('40')
    expect(await screen.findByText(/14 of 14 items will run for \$31\.80 of the \$40\.00 envelope\./)).toBeTruthy()
    expect(screen.getByText('Nightly budget: $40.00')).toBeTruthy()
    expect(
      screen.getByText(
        'Tonight’s plan was made with a $25.00 envelope; run and cut above use $40.00, and the Orchestrator re-plans against it on its next preview.',
      ),
    ).toBeTruthy()
    expect((await fetchQueue()).envelopeUsd).toBe(40)
  })

  it('cuts more when the budget goes down', async () => {
    await renderQueue()
    await changeBudget('10')
    expect(await screen.findByText(/items will run for \$[\d.]+ of the \$10\.00 envelope; \d+ cut\./)).toBeTruthy()
  })

  it('refuses an invalid budget before saving, and keeps the old one', async () => {
    await renderQueue()
    await changeBudget('0')
    expect(await screen.findByText('The nightly budget must be more than $0')).toBeTruthy()
    expect((await fetchQueue()).envelopeUsd).toBe(25)
  })

  it('cancelling leaves the budget alone', async () => {
    await renderQueue()
    fireEvent.click(screen.getByRole('button', { name: 'Change nightly budget' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel budget change' }))
    expect(screen.getByText('Nightly budget: $25.00')).toBeTruthy()
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
