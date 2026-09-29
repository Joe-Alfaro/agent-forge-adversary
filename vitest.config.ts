import { defineConfig } from 'vitest/config'

// Each workspace that needs its own environment (the dashboard runs DOM tests
// under jsdom) keeps its own vitest config; everything else runs under node here.
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'node',
          include: ['packages/**/*.test.ts', 'apps/worker/**/*.test.ts'],
          environment: 'node',
        },
      },
      'apps/dashboard',
    ],
  },
})
