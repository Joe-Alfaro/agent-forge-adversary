import { cleanup, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { fetchMorningReport } from '../../lib/data-source.js'
import { renderWithProviders } from '../../test-utils.js'
import { MorningReportView } from '../MorningReportView.js'

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
})
