// @vitest-environment node
import { describe, expect, it } from 'vitest'

import { resolveDashboardConfig } from '../config.js'

describe('resolveDashboardConfig', () => {
  it('uses fixtures when asked, without needing a database', () => {
    expect(resolveDashboardConfig({ DASHBOARD_DATA_SOURCE: 'fixtures' })).toMatchObject({ mode: 'fixtures' })
  })

  it('defaults to Postgres and requires DATABASE_URL', () => {
    expect(() => resolveDashboardConfig({})).toThrow('DATABASE_URL')
    expect(resolveDashboardConfig({ DATABASE_URL: 'postgres://x' })).toMatchObject({
      mode: 'postgres',
      connectionString: 'postgres://x',
    })
  })

  it('rejects unknown modes instead of silently falling back', () => {
    expect(() => resolveDashboardConfig({ DASHBOARD_DATA_SOURCE: 'mysql' })).toThrow('mysql')
  })

  it('reads the budget envelope and nightly schedule', () => {
    const config = resolveDashboardConfig({
      DASHBOARD_DATA_SOURCE: 'fixtures',
      NIGHTLY_BUDGET_USD: '30',
      NIGHTLY_CRON: '0 2 * * *',
    })
    expect(config).toMatchObject({ envelopeUsd: 30, runHour: 2, timeZone: 'America/Chicago', coverageMinAttempts: 20 })
  })

  it('reads the M5 attempt threshold and rejects a nonsensical one', () => {
    expect(resolveDashboardConfig({ DASHBOARD_DATA_SOURCE: 'fixtures', COVERAGE_MIN_ATTEMPTS: '50' }).coverageMinAttempts).toBe(50)
    expect(() => resolveDashboardConfig({ DASHBOARD_DATA_SOURCE: 'fixtures', COVERAGE_MIN_ATTEMPTS: '0' })).toThrow(
      'COVERAGE_MIN_ATTEMPTS',
    )
  })

  it('defaults the envelope to $25 and rejects a non-numeric one', () => {
    expect(resolveDashboardConfig({ DASHBOARD_DATA_SOURCE: 'fixtures' }).envelopeUsd).toBe(25)
    expect(() => resolveDashboardConfig({ DASHBOARD_DATA_SOURCE: 'fixtures', NIGHTLY_BUDGET_USD: 'lots' })).toThrow(
      'NIGHTLY_BUDGET_USD',
    )
  })
})
