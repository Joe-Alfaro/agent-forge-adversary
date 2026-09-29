import '@tanstack/react-start/server-only'

import path from 'node:path'

import pg from 'pg'

import { type DataSourceMode, resolveDashboardConfig } from './config.js'
import { loadEvalTaxonomy } from './eval-taxonomy.js'
import { createFixtureRepository } from './fixture-repository.js'
import { createPgRepository } from './pg-repository.js'
import type { DashboardRepository } from './repository.js'

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
  // npm workspace scripts run from apps/dashboard, so the repo's evals/ is two levels up.
  const seedsDir = process.env.EVALS_SEEDS_DIR || path.resolve(process.cwd(), '../../evals/seeds')
  return {
    mode: config.mode,
    repository: createPgRepository({ pool, config, loadTaxonomy: () => loadEvalTaxonomy(seedsDir) }),
  }
}

/** One repository (and one Postgres pool) per server process, chosen by DASHBOARD_DATA_SOURCE. */
export function getRuntime(): Runtime {
  cache.runtime ??= createRuntime()
  return cache.runtime
}

export function getRepository(): DashboardRepository {
  return getRuntime().repository
}
