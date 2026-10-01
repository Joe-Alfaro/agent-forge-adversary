import '@tanstack/react-start/server-only'

import pg from 'pg'

import { type DataSourceMode, resolveDashboardConfig } from './config.js'
import { createFixtureRepository } from './fixture-repository.js'
import { createPgRepository } from './pg-repository.js'
import type { DashboardRepository } from './repository.js'
import { createWorkerPlanner } from './worker-planner.js'

interface Runtime {
  mode: DataSourceMode
  repository: DashboardRepository
}

const cache: { runtime?: Runtime } = {}

function createRuntime(): Runtime {
  const config = resolveDashboardConfig(process.env)
  if (config.mode === 'fixtures') {
    return { mode: config.mode, repository: createFixtureRepository({ config }) }
  }
  const pool = new pg.Pool({ connectionString: config.connectionString, max: 5 })
  // "Plan tonight now" runs the Orchestrator's planner (@agentforge/worker/planning) against the same pool.
  return { mode: config.mode, repository: createPgRepository({ pool, config, planner: createWorkerPlanner(pool) }) }
}

/** One repository (and one Postgres pool) per server process, chosen by DASHBOARD_DATA_SOURCE. */
export function getRuntime(): Runtime {
  cache.runtime ??= createRuntime()
  return cache.runtime
}

export function getRepository(): DashboardRepository {
  return getRuntime().repository
}
