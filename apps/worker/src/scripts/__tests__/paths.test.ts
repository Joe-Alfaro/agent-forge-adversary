import { isAbsolute } from 'node:path'

import { describe, expect, it } from 'vitest'

import { seedDir } from '../paths.js'

describe('seedDir', () => {
  it('defaults to the repo evals/seeds directory', () => {
    expect(seedDir({})).toMatch(/evals\/seeds$/)
  })

  it('honours RUN_SEED_DIR so a focused chase set runs without touching the standing suite', () => {
    expect(seedDir({ RUN_SEED_DIR: '/tmp/chase/pi-003' })).toBe('/tmp/chase/pi-003')
  })

  it('resolves a relative RUN_SEED_DIR against the repo root (not cwd), so it works under npm -w', () => {
    const resolved = seedDir({ RUN_SEED_DIR: 'evals/chase/pi-003' })
    expect(isAbsolute(resolved)).toBe(true)
    // The repo-root form the default seedDir uses, with the override path appended.
    expect(resolved).toBe(seedDir({}).replace(/evals\/seeds$/, 'evals/chase/pi-003'))
  })
})
