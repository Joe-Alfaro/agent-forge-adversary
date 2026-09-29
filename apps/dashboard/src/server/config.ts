import { resolveDbConfig } from '@agentforge/db'

import { runHourFromCron } from '../lib/schedule.js'

export type DataSourceMode = 'fixtures' | 'postgres'

export interface QueueConfig {
  envelopeUsd: number
  timeZone: string
  runHour: number
}

export type DashboardConfig = QueueConfig &
  ({ mode: 'fixtures' } | { mode: 'postgres'; connectionString: string })

/** The nightly run is scheduled in Central Time (ARCHITECTURE.md Section 7.0). */
const DEFAULT_TIME_ZONE = 'America/Chicago'
const DEFAULT_ENVELOPE_USD = 25

type Env = NodeJS.ProcessEnv

function readEnvelope(env: Env): number {
  const raw = env.NIGHTLY_BUDGET_USD
  if (raw === undefined || raw === '') {
    return DEFAULT_ENVELOPE_USD
  }
  const value = Number(raw)
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`NIGHTLY_BUDGET_USD must be a non-negative number, got "${raw}"`)
  }
  return value
}

/**
 * DASHBOARD_DATA_SOURCE=fixtures serves the synthetic demo data; anything else
 * requires Postgres. There is no silent fallback, so a missing DATABASE_URL on
 * a real run fails loudly instead of showing fake findings.
 */
export function resolveDashboardConfig(env: Env): DashboardConfig {
  const queue: QueueConfig = {
    envelopeUsd: readEnvelope(env),
    timeZone: env.NIGHTLY_TIMEZONE || DEFAULT_TIME_ZONE,
    runHour: runHourFromCron(env.NIGHTLY_CRON),
  }
  const mode = env.DASHBOARD_DATA_SOURCE || 'postgres'
  if (mode === 'fixtures') {
    return { ...queue, mode }
  }
  if (mode !== 'postgres') {
    throw new Error(`DASHBOARD_DATA_SOURCE must be "fixtures" or "postgres", got "${mode}"`)
  }
  if (!env.DATABASE_URL) {
    throw new Error('DATABASE_URL is not set. Set it, or run with DASHBOARD_DATA_SOURCE=fixtures for demo data.')
  }
  return { ...queue, mode, connectionString: resolveDbConfig(env).connectionString }
}
