import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import type { CoverageCell } from '../../lib/models.js'
import { CoverageHeatmap } from '../CoverageHeatmap.js'

const cells: CoverageCell[] = [
  { category: 'prompt_injection', subcategory: 'direct', owaspIds: ['LLM01'], attempts: 420, confirmed: 3, lastRunAt: '2026-09-28T09:10:00Z' },
  { category: 'prompt_injection', subcategory: 'multi-turn', owaspIds: [], attempts: 0, confirmed: 0 },
  { category: 'denial_of_service', subcategory: 'token_exhaustion', owaspIds: [], attempts: 0, confirmed: 0 },
]

afterEach(cleanup)

describe('CoverageHeatmap', () => {
  it('draws a row per category with a tile per subcategory', () => {
    render(<CoverageHeatmap cells={cells} />)
    const injection = screen.getByRole('group', { name: 'prompt injection' })
    expect(within(injection).getAllByRole('listitem')).toHaveLength(2)
    expect(screen.getByRole('group', { name: 'denial of service' })).toBeTruthy()
  })

  it('labels untested gaps in text, not color alone', () => {
    render(<CoverageHeatmap cells={cells} />)
    const gap = screen.getByRole('listitem', { name: /multi-turn: untested/ })
    expect(within(gap).getByText('Untested')).toBeTruthy()
  })

  it('gives each tested tile an accessible summary and a hover tooltip', () => {
    render(<CoverageHeatmap cells={cells} />)
    const tile = screen.getByRole('listitem', {
      name: 'direct: 420 attempts, 3 confirmed, last tested 2026-09-28 09:10 UTC',
    })
    expect(tile.getAttribute('title')).toBe(tile.getAttribute('aria-label'))
    expect(within(tile).getByText('420')).toBeTruthy()
    expect(within(tile).getByText('3 confirmed')).toBeTruthy()
  })

  it('counts the gaps in its summary line', () => {
    render(<CoverageHeatmap cells={cells} />)
    expect(screen.getByText('2 of 3 cells untested on this version.')).toBeTruthy()
  })
})
