import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { AppNav } from '../AppNav.js'

/** A router with the dashboard's paths and stub pages, so the nav is tested against real routing. */
function renderWithRouter(initialPath: string) {
  const rootRoute = createRootRoute({
    component: function Layout() {
      return (
        <>
          <AppNav />
          <Outlet />
        </>
      )
    },
  })
  const pages = ['findings', 'runs', 'coverage', 'cost'].map((page) =>
    createRoute({
      getParentRoute: () => rootRoute,
      path: `/${page}`,
      component: function Page() {
        return <h1>{`${page} page`}</h1>
      },
    }),
  )
  const router = createRouter({
    routeTree: rootRoute.addChildren(pages),
    history: createMemoryHistory({ initialEntries: [initialPath] }),
  })
  render(<RouterProvider router={router} />)
  return router
}

afterEach(cleanup)

describe('AppNav', () => {
  it('lists every read-only panel', async () => {
    renderWithRouter('/findings')
    const nav = await screen.findByRole('navigation', { name: 'Dashboard' })
    const labels = Array.from(nav.querySelectorAll('a')).map((link) => link.textContent)
    expect(labels).toEqual(['Findings', 'Run history', 'Coverage', 'Cost'])
  })

  it('marks the current panel', async () => {
    renderWithRouter('/coverage')
    const link = await screen.findByRole('link', { name: 'Coverage' })
    expect(link.getAttribute('aria-current')).toBe('page')
    expect(screen.getByRole('link', { name: 'Findings' }).getAttribute('aria-current')).toBeNull()
  })

  it('switches panels when a link is clicked', async () => {
    const router = renderWithRouter('/findings')
    await screen.findByRole('heading', { name: 'findings page' })
    fireEvent.click(screen.getByRole('link', { name: 'Run history' }))
    expect(await screen.findByRole('heading', { name: 'runs page' })).toBeTruthy()
    expect(router.state.location.pathname).toBe('/runs')
  })
})
