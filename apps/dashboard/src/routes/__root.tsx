import { createRootRouteWithContext, HeadContent, Outlet, Scripts } from '@tanstack/react-router'
import type { ReactNode } from 'react'

import { AppNav } from '../components/AppNav.js'
import type { RouterContext } from '../router.js'
import appCss from '../styles/app.css?url'

export const Route = createRootRouteWithContext<RouterContext>()({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: 'AgentForge Operator Dashboard' },
    ],
    links: [{ rel: 'stylesheet', href: appCss }],
  }),
  shellComponent: RootDocument,
  component: AppLayout,
  notFoundComponent: NotFound,
})

function RootDocument({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  )
}

function AppLayout() {
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <p className="brand">AgentForge</p>
        <p className="brand-sub">Operator dashboard · read-only</p>
        <AppNav />
      </aside>
      <main className="content">
        <Outlet />
      </main>
    </div>
  )
}

function NotFound() {
  return <p>That panel does not exist.</p>
}
