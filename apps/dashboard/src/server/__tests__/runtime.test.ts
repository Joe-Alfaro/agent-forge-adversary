// @vitest-environment node
import { describe, expect, it } from 'vitest'

import { operatorName, resolveDashboardConfig } from '../config.js'

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
    expect(config).toMatchObject({ envelopeUsd: 30, runHour: 2, timeZone: 'America/Chicago', coverageTargetAttempts: 20 })
  })

  it('reads the M5 attempt target (target_attempts, §7.2) and rejects a nonsensical one', () => {
    expect(
      resolveDashboardConfig({ DASHBOARD_DATA_SOURCE: 'fixtures', COVERAGE_TARGET_ATTEMPTS: '50' }).coverageTargetAttempts,
    ).toBe(50)
    expect(() => resolveDashboardConfig({ DASHBOARD_DATA_SOURCE: 'fixtures', COVERAGE_TARGET_ATTEMPTS: '0' })).toThrow(
      'COVERAGE_TARGET_ATTEMPTS',
    )
  })

  it('defaults the envelope to $25 and rejects a non-numeric one', () => {
    expect(resolveDashboardConfig({ DASHBOARD_DATA_SOURCE: 'fixtures' }).envelopeUsd).toBe(25)
    expect(() => resolveDashboardConfig({ DASHBOARD_DATA_SOURCE: 'fixtures', NIGHTLY_BUDGET_USD: 'lots' })).toThrow(
      'NIGHTLY_BUDGET_USD',
    )
  })
})

describe('operatorName', () => {
  it('records decisions under the login username, defaulting like the login does', () => {
    expect(operatorName({ OPERATOR_USERNAME: 'priya' })).toBe('priya')
    expect(operatorName({})).toBe('operator')
  })
})

describe('RUN_NOW_ENABLED', () => {
  const base = { DASHBOARD_DATA_SOURCE: 'fixtures' }

  it('defaults to enabled', () => {
    expect(resolveDashboardConfig(base).runNowEnabled).toBe(true)
  })

  it('reads true and false spellings', () => {
    expect(resolveDashboardConfig({ ...base, RUN_NOW_ENABLED: 'false' }).runNowEnabled).toBe(false)
    expect(resolveDashboardConfig({ ...base, RUN_NOW_ENABLED: '0' }).runNowEnabled).toBe(false)
    expect(resolveDashboardConfig({ ...base, RUN_NOW_ENABLED: 'TRUE' }).runNowEnabled).toBe(true)
    expect(resolveDashboardConfig({ ...base, RUN_NOW_ENABLED: '1' }).runNowEnabled).toBe(true)
  })

  it('refuses anything else, so a typo cannot silently enable it on Railway', () => {
    expect(() => resolveDashboardConfig({ ...base, RUN_NOW_ENABLED: 'off-ish' })).toThrow('RUN_NOW_ENABLED')
  })
})
