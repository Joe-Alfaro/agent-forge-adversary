import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'
import { render } from '@testing-library/react'
import type { ReactNode } from 'react'

function createTestQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
}

/**
 * Runs `preload` against a fresh cache (e.g. `client.ensureQueryData(queueQuery)`), then renders. Components reading them
 * with useSuspenseQuery then render straight away instead of suspending, which
 * avoids React 19's ~300 ms Suspense reveal throttle on every test and keeps
 * these tests fast and stable when the whole suite runs in parallel.
 */
export async function renderReady(ui: ReactNode, preload: (client: QueryClient) => Promise<unknown>) {
  const queryClient = createTestQueryClient()
  await preload(queryClient)
  return renderWithProviders(ui, queryClient)
}

/**
 * Renders `ui` inside a fresh QueryClient and a memory router, so components
 * that use Links or query hooks behave as they do in the app.
 */
export function renderWithProviders(ui: ReactNode, queryClient = createTestQueryClient()) {
  const rootRoute = createRootRoute({ component: () => ui })
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })
  const result = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
  return { ...result, queryClient, router }
}
