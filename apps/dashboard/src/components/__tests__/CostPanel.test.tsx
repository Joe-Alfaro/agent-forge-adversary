import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { CostPanel } from '../CostPanel.js'

afterEach(cleanup)

describe('CostPanel', () => {
  it('computes role shares from unrounded spend, not the cents-rounded total', () => {
    render(
      <CostPanel
        cost={{
          periodLabel: 'Last 30 days',
          totalUsd: 0.06,
          byRole: [{ role: 'judge', spendUsd: 0.056 }],
          byRun: [],
          projectedMonthlyUsd: 1.68,
        }}
      />,
    )
    const row = screen.getByRole('row', { name: /judge/i })
    expect(within(row).getByText('100%')).toBeTruthy()
  })
})
