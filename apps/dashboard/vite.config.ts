import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import viteReact from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  server: {
    // IPv4 loopback so `ao preview http://127.0.0.1:3100` reaches it; Vite otherwise may bind only ::1.
    host: '127.0.0.1',
    port: 3100,
  },
  // Pre-bundle what the client entry discovers late, so the first page load after a
  // dev-server start does not fail and force a reload.
  optimizeDeps: {
    include: [
      '@tanstack/router-core',
      '@tanstack/router-core/isServer',
      '@tanstack/router-core/ssr/client',
      'seroval',
    ],
  },
  // Load the workspace packages from node_modules at runtime instead of inlining them:
  // @agentforge/contracts requires its JSON schemas by a path relative to its own dist,
  // Only server code (src/server/runtime.ts) imports @agentforge/planner, so it never
  // reaches the client.
  ssr: {
    external: ['@agentforge/contracts', '@agentforge/db', '@agentforge/planner'],
  },
  // Start's plugin must run before the React plugin so route files are transformed first.
  plugins: [tanstackStart(), viteReact()],
})
