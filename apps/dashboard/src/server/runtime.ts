import '@tanstack/react-start/server-only'

import pg from 'pg'

import { taxonomyCells } from '../lib/coverage.js'
import { ATTACK_TAXONOMY } from '../lib/taxonomy.js'
import { type DataSourceMode, resolveDashboardConfig } from './config.js'
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
  const taxonomy = taxonomyCells(ATTACK_TAXONOMY)
  if (config.mode === 'fixtures') {
    return { mode: config.mode, repository: createFixtureRepository({ config, taxonomy }) }
  }
  const pool = new pg.Pool({ connectionString: config.connectionString, max: 5 })
  return { mode: config.mode, repository: createPgRepository({ pool, config, taxonomy }) }
}

/** One repository (and one Postgres pool) per server process, chosen by DASHBOARD_DATA_SOURCE. */
export function getRuntime(): Runtime {
  cache.runtime ??= createRuntime()
  return cache.runtime
}

export function getRepository(): DashboardRepository {
  return getRuntime().repository
}
