import { planNextNightly } from '@agentforge/worker/planning'
import type pg from 'pg'

import type { TonightPlanner } from './planner.js'

/**
 * "Plan tonight now" through the Orchestrator's planner
 * (@agentforge/worker/planning): a dry run that upserts the one standing
 * scheduled cron plan row. It makes no target or model call, spends nothing,
 * and does not drain operator_requests. Server-only; the worker package is an
 * SSR external, so it never reaches the client bundle.
 */
export function createWorkerPlanner(pool: pg.Pool, env: NodeJS.ProcessEnv = process.env): TonightPlanner {
  return {
    async planTonight({ now }) {
      await planNextNightly({ pool, env, now })
    },
  }
}
