import { planTonightNow } from '@agentforge/planner'
import type pg from 'pg'

import type { TonightPlanner } from './planner.js'

/**
 * "Plan tonight now" through the Orchestrator's one planner (@agentforge/planner):
 * a dry run that upserts the one standing scheduled cron plan row, with no
 * target or model call, no spend, and no draining of operator_requests. Its
 * seeds are embedded, so it needs no evals/ on disk. Server-only; the package
 * is an SSR external, so it never reaches the client bundle.
 */
export function createOrchestratorPlanner(pool: pg.Pool, env: NodeJS.ProcessEnv = process.env): TonightPlanner {
  return {
    async planTonight({ now }) {
      await planTonightNow({ pool, env, now })
    },
  }
}
