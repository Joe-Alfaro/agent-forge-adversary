import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import type { CoverageCell } from '../../lib/models.js'
import type { M5Summary } from '../../lib/models.js'
import { CoverageHeatmap } from '../CoverageHeatmap.js'

const cells: CoverageCell[] = [
  { category: 'prompt_injection', subcategory: 'direct', owaspIds: ['LLM01'], attempts: 420, confirmed: 3, lastRunAt: '2026-09-28T09:10:00Z' },
  { category: 'prompt_injection', subcategory: 'multi_turn', owaspIds: [], attempts: 0, confirmed: 0 },
  { category: 'denial_of_service', subcategory: 'token_exhaustion', owaspIds: [], attempts: 0, confirmed: 0 },
  { category: 'misinformation', subcategory: 'unsupported_claim', owaspIds: [], attempts: 0, confirmed: 0 },
]

const prdCategories: CoverageCell['category'][] = ['prompt_injection', 'denial_of_service']

const m5: M5Summary = {
  total: 6,
  covered: 1,
  minAttempts: 20,
  windowDays: 7,
  highRiskKeys: ['prompt_injection/direct', 'denial_of_service/token_exhaustion'],
  coveredKeys: ['prompt_injection/direct'],
  trackedKeys: ['misinformation/unsupported_claim'],
}

afterEach(cleanup)

describe('CoverageHeatmap', () => {
  it('draws a row per category with a tile per subcategory', () => {
    render(<CoverageHeatmap cells={cells} m5={m5} prdCategories={prdCategories} />)
    const injection = screen.getByRole('group', { name: 'prompt injection' })
    expect(within(injection).getAllByRole('listitem')).toHaveLength(2)
    expect(screen.getByRole('group', { name: 'denial of service' })).toBeTruthy()
  })

  it('labels untested gaps in text, not color alone', () => {
    render(<CoverageHeatmap cells={cells} m5={m5} prdCategories={prdCategories} />)
    const gap = screen.getByRole('listitem', { name: /multi turn: untested/ })
    expect(within(gap).getByText('Untested')).toBeTruthy()
  })

  it('gives each tested tile an accessible summary and a hover tooltip', () => {
    render(<CoverageHeatmap cells={cells} m5={m5} prdCategories={prdCategories} />)
    const tile = screen.getByRole('listitem', {
      name: 'direct: 420 attempts, 3 confirmed, last tested 2026-09-28 09:10 UTC. High risk, covered for M5',
    })
    expect(tile.getAttribute('title')).toBe(tile.getAttribute('aria-label'))
    expect(within(tile).getByText('420')).toBeTruthy()
    expect(within(tile).getByText('3 confirmed')).toBeTruthy()
  })

  it('outlines high-risk cells and says whether each counts toward M5', () => {
    render(<CoverageHeatmap cells={cells} m5={m5} prdCategories={prdCategories} />)
    const gap = screen.getByRole('listitem', { name: /token exhaustion: untested\. High risk, not covered for M5/ })
    expect(gap.className).toContain('heat-high-risk')
    expect(screen.getByRole('listitem', { name: /multi turn: untested$/ }).className).not.toContain('heat-high-risk')
  })

  it('outlines tracked non-PRD high-risk cells differently and says they are outside M5', () => {
    render(<CoverageHeatmap cells={cells} m5={m5} prdCategories={prdCategories} />)
    const tile = screen.getByRole('listitem', { name: /unsupported claim: untested\. High risk, outside M5/ })
    expect(tile.className).toContain('heat-tracked-risk')
    expect(tile.className).not.toContain('heat-high-risk')
  })

  it('reports M5 as covered high-risk cells out of the total', () => {
    render(<CoverageHeatmap cells={cells} m5={m5} prdCategories={prdCategories} />)
    expect(screen.getByText('M5: 1 of 6 high-risk cells covered (17%)')).toBeTruthy()
    expect(
      screen.getByText(
        'Covered = at least 20 attempts, at least one variant family exercised, and a run in the last 7 days.',
      ),
    ).toBeTruthy()
  })

  it('counts the gaps in its summary line', () => {
    render(<CoverageHeatmap cells={cells} m5={m5} prdCategories={prdCategories} />)
    expect(screen.getByText('3 of 4 cells untested on this version.')).toBeTruthy()
  })

  it('marks categories outside the PRD set', () => {
    render(<CoverageHeatmap cells={cells} m5={m5} prdCategories={prdCategories} />)
    expect(within(screen.getByRole('group', { name: 'misinformation (outside PRD set)' })).getAllByRole('listitem')).toHaveLength(1)
    expect(screen.getByRole('group', { name: 'prompt injection' })).toBeTruthy()
  })
})
