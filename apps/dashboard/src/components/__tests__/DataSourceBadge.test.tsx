import { cleanup, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { renderWithProviders } from '../../test-utils.js'
import { DataSourceBadge } from '../DataSourceBadge.js'

const mode = vi.hoisted(() => ({ current: 'fixtures' as 'fixtures' | 'postgres' }))

vi.mock('../../lib/data-source.js', async () => ({
  ...(await import('../../test-data-source.js')),
  fetchDataSourceMode: async () => mode.current,
}))

afterEach(cleanup)

describe('DataSourceBadge', () => {
  it('warns that the dashboard is showing synthetic demo data', async () => {
    mode.current = 'fixtures'
    renderWithProviders(<DataSourceBadge />)
    expect(await screen.findByText('Demo data (fixtures)')).toBeTruthy()
  })

  it('shows nothing when reading the live database', async () => {
    mode.current = 'postgres'
    const { container } = renderWithProviders(<DataSourceBadge />)
    await screen.findByTestId('data-source-live')
    expect(container.textContent).toBe('')
  })
})
