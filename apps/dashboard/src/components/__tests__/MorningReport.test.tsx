import { cleanup, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { MorningReport } from '../../lib/models.js'
import { fetchMorningReport } from '../../test-data-source.js'
import { renderWithProviders } from '../../test-utils.js'
import { MorningReportView } from '../MorningReportView.js'

vi.mock('../../lib/data-source.js', () => import('../../test-data-source.js'))

afterEach(cleanup)

describe('MorningReportView', () => {
  it('summarizes the run and links every ticket it mentions', async () => {
    const report = await fetchMorningReport('run-2026-09-28')
    if (!report) {
      throw new Error('missing fixture report')
    }
    renderWithProviders(<MorningReportView report={report} />)
    expect(await screen.findByText(report.headline)).toBeTruthy()
    expect(screen.getByRole('region', { name: 'Regressions' })).toHaveProperty(
      'textContent',
      expect.stringContaining('AF-2026-0004'),
    )
    expect(screen.getByRole('link', { name: 'AF-2026-0006' }).getAttribute('href')).toBe('/findings/AF-2026-0006')
    expect(screen.getByText('4 ran, 1 cut')).toBeTruthy()
  })

  it('links the Langfuse trace and shows spend and the queue outcome', async () => {
    const report = await fetchMorningReport('run-2026-09-28')
    if (!report) {
      throw new Error('missing fixture report')
    }
    renderWithProviders(<MorningReportView report={report} />)
    const trace = await screen.findByRole('link', { name: 'Open the Langfuse trace' })
    expect(trace.getAttribute('href')).toBe('https://langfuse.example/trace/run-2026-09-28')
    expect(trace.getAttribute('rel')).toContain('noreferrer')
    expect(screen.getByText('$46.20')).toBeTruthy()
    expect(screen.getByText('Queue (plan items)')).toBeTruthy()
  })

  it('reads cleanly for a quiet run: no tickets, no notes, no trace', async () => {
    const report: MorningReport = {
      runId: '12',
      status: 'completed',
      targetVersion: 'copilot@c1f011e',
      generatedAt: '2026-09-30T07:40:00.000Z',
      headline: '140 attempts, 0 new finding(s)',
      attempts: 140,
      verdicts: { success: 0, partial: 3, fail: 137 },
      spendUsd: 2.4,
      newTickets: [],
      regressions: [],
      verifiedFixes: [],
      queue: { ran: 5, cut: 0 },
      notes: [],
    }
    renderWithProviders(<MorningReportView report={report} />)
    expect(await screen.findByText('No new findings.')).toBeTruthy()
    expect(screen.getByText('No regressions.')).toBeTruthy()
    expect(screen.getByText('No fixes verified.')).toBeTruthy()
    expect(screen.getByText('No notes.')).toBeTruthy()
    expect(screen.queryByRole('link', { name: 'Open the Langfuse trace' })).toBeNull()
  })

  it('renders a cap-stopped (aborted) run’s report and says why it stopped', async () => {
    const report: MorningReport = {
      runId: '4',
      status: 'aborted',
      abortReason: 'Spend cap $0.35 reached; aborted before completing cell-prompt_injection/direct.',
      targetVersion: 'copilot@c1f011e',
      generatedAt: '2026-10-02T07:40:00.000Z',
      headline: '84 attempts, 0 new finding(s), 0 success / 0 partial / 84 fail; spend $0.359 (aborted at cap)',
      attempts: 84,
      verdicts: { success: 0, partial: 0, fail: 84 },
      spendUsd: 0.36,
      newTickets: [],
      regressions: [],
      verifiedFixes: [],
      queue: { ran: 2, cut: 1 },
      notes: ['Spend cap $0.35 reached; aborted before completing cell-prompt_injection/direct.'],
    }
    renderWithProviders(<MorningReportView report={report} />)
    expect(await screen.findByText(report.headline)).toBeTruthy()
    const banner = screen.getByRole('note', { name: 'Run stopped early' })
    expect(banner.textContent).toContain('Aborted: the run stopped before finishing; this report covers what ran.')
    expect(banner.textContent).toContain('Spend cap $0.35 reached; aborted before completing cell-prompt_injection/direct.')
  })

  it('has no stopped-early banner for a completed run', async () => {
    const report = await fetchMorningReport('run-2026-09-28')
    if (!report) {
      throw new Error('missing fixture report')
    }
    renderWithProviders(<MorningReportView report={report} />)
    await screen.findByText(report.headline)
    expect(screen.queryByRole('note', { name: 'Run stopped early' })).toBeNull()
  })
})
