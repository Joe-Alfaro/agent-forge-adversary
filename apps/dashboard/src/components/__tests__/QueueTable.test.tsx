import { cleanup, fireEvent, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { QueueItem } from '../../lib/models.js'
import { type PlanItem, planTonightRows } from '../../lib/tonight.js'
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
    estimatedCostUsd: 2,
  },
  {
    id: 'req-2',
    kind: 'focus',
    category: 'data_exfiltration',
    requestedBy: 'sam',
    requestedAt: '2026-09-29T08:20:00Z',
    source: 'chat',
    estimatedCostUsd: 0,
  },
]

const campaigns: PlanItem[] = [
  {
    itemId: 'reg-AF-2026-0006',
    kind: 'regression',
    regressionCause: 'target_changed',
    exploitId: 'AF-2026-0006',
    category: 'data_exfiltration',
    subcategory: 'cross_patient',
    owaspIds: ['LLM02'],
    estimatedCostUsd: 0,
    maxAttempts: 3,
    reason: 'regression for AF-2026-0006: target version changed since the last run',
  },
  {
    itemId: 'cell-data_exfiltration/phi_leakage',
    kind: 'coverage_campaign',
    category: 'data_exfiltration',
    subcategory: 'phi_leakage',
    owaspIds: ['LLM02', 'A01'],
    priority: 1000.82,
    estimatedCostUsd: 6,
    maxAttempts: 40,
    reason: 'coverage priority 1000.820',
  },
  {
    itemId: 'cell-tool_misuse/parameter_tampering',
    kind: 'coverage_campaign',
    category: 'tool_misuse',
    subcategory: 'parameter_tampering',
    owaspIds: ['LLM06'],
    priority: 0.51,
    estimatedCostUsd: 4,
    maxAttempts: 40,
    reason: 'coverage priority 0.510',
  },
]

async function renderQueue() {
  const onRemove = vi.fn()
  const onMove = vi.fn()
  const onRunNow = vi.fn()
  renderWithProviders(
    <QueueTable rows={planTonightRows(items, campaigns, 10)} onRemove={onRemove} onMove={onMove} onRunNow={onRunNow} />,
  )
  await screen.findByRole('table')
  const [, body] = screen.getAllByRole('rowgroup')
  if (!body) {
    throw new Error('queue table has no body')
  }
  return { onRemove, onMove, onRunNow, rows: within(body).getAllByRole('row') }
}

afterEach(cleanup)

describe('QueueTable', () => {
  it('lists operator requests, then the Orchestrator’s regressions and coverage campaigns, in run order', async () => {
    const { rows } = await renderQueue()
    expect(rows).toHaveLength(5)
    expect(within(rows[0] as HTMLElement).getByRole('link', { name: 'AF-2026-0004' })).toBeTruthy()
    expect(within(rows[1] as HTMLElement).getByText('data exfiltration')).toBeTruthy()
    expect(within(rows[2] as HTMLElement).getByText('regression')).toBeTruthy()
    expect(within(rows[3] as HTMLElement).getByText('coverage campaign')).toBeTruthy()
    expect(within(rows[3] as HTMLElement).getByText('data exfiltration / phi leakage')).toBeTruthy()
  })

  it('shows a regression’s ticket and why it is owed', async () => {
    const { rows } = await renderQueue()
    const regression = within(rows[2] as HTMLElement)
    expect(regression.getByRole('link', { name: 'AF-2026-0006' })).toBeTruthy()
    expect(regression.getByText('Target version changed · 3 replays')).toBeTruthy()
    expect(regression.getByRole('list', { name: 'OWASP' }).textContent).toBe('LLM02')
    expect(regression.queryAllByRole('button')).toEqual([])
  })

  it('shows each campaign’s OWASP tags, priority, and cost', async () => {
    const { rows } = await renderQueue()
    const campaign = within(rows[3] as HTMLElement)
    expect(campaign.getByRole('list', { name: 'OWASP' }).textContent).toBe('LLM02A01')
    expect(campaign.getByText('0.82 + focus')).toBeTruthy()
    expect(campaign.getByText('$6.00')).toBeTruthy()
    expect(within(rows[4] as HTMLElement).getByText('0.51')).toBeTruthy()
  })

  it('marks what will run and what the envelope cuts, with the running total of what runs', async () => {
    const { rows } = await renderQueue()
    // 2 + 0 + 6 = 8 runs; the $4 campaign would make 12, over the $10 envelope.
    expect(within(rows[3] as HTMLElement).getByText('Will run')).toBeTruthy()
    expect(within(rows[3] as HTMLElement).getByText('$8.00')).toBeTruthy()
    expect(within(rows[4] as HTMLElement).getByText('Will be cut')).toBeTruthy()
  })

  it('keeps campaigns read-only: no reorder, remove, or run-now controls', async () => {
    const { rows } = await renderQueue()
    expect(within(rows[3] as HTMLElement).queryAllByRole('button')).toEqual([])
    expect(within(rows[3] as HTMLElement).getByText('Orchestrator')).toBeTruthy()
    expect(within(rows[3] as HTMLElement).getByText('40 attempts')).toBeTruthy()
  })

  it('reorders, removes, and runs operator requests through the callbacks', async () => {
    const { onRemove, onMove, onRunNow } = await renderQueue()
    fireEvent.click(screen.getByRole('button', { name: 'Move request 2 up' }))
    expect(onMove).toHaveBeenCalledWith('req-2', 'up')
    fireEvent.click(screen.getByRole('button', { name: 'Remove request 1' }))
    expect(onRemove).toHaveBeenCalledWith('req-1')
    fireEvent.click(screen.getByRole('button', { name: 'Run request 1 now' }))
    expect(onRunNow).toHaveBeenCalledWith('req-1')
  })

  it('moves operator requests only among themselves', async () => {
    await renderQueue()
    expect(screen.getByRole('button', { name: 'Move request 1 up' })).toHaveProperty('disabled', true)
    expect(screen.getByRole('button', { name: 'Move request 2 down' })).toHaveProperty('disabled', true)
  })
})
