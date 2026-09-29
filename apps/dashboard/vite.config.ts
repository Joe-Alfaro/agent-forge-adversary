import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import viteReact from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  server: {
    // IPv4 loopback so `ao preview http://127.0.0.1:3100` reaches it; Vite otherwise may bind only ::1.
    host: '127.0.0.1',
    port: 3100,
  },
  // Start's plugin must run before the React plugin so route files are transformed first.
  plugins: [tanstackStart(), viteReact()],
})
