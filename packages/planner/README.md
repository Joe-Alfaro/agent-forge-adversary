# @agentforge/planner

The Orchestrator's nightly planner (ARCHITECTURE 7.0, 7.2), as a workspace
package so both the worker and the dashboard server can import it.

```ts
import { planTonightNow } from '@agentforge/planner'

const { nightlyRunId, created, scheduledFor, plan } = await planTonightNow({ pool, now, env })
```

- **Dry run.** Reads queued `operator_requests`, owed regressions, the coverage
  matrix, and the operator budget; builds a schema-valid `NightlyPlan v1`. No
  target or model call, no spend, and the queue is not drained.
- **One standing row.** Upserts the single `nightly_runs` row with
  `trigger = 'cron'`, `status = 'scheduled'` (advisory-locked); the dashboard
  reads the latest by `scheduled_for DESC, id DESC`.
- **Config from env:** envelope = `platform_settings.nightly_budget_usd`, else
  `NIGHTLY_BUDGET_USD`, else $25; `PLAN_TOP_K`, `PLAN_MAX_ATTEMPTS`,
  `PLAN_COST_PER_ATTEMPT_USD`, `PLAN_CATEGORIES`, `PLAN_TARGET_VERSION`,
  `NIGHTLY_HOUR` / `NIGHTLY_TZ` (next 01:00 America/Chicago by default).
- **Seeds are embedded** (`SEED_INDEX`: id, cell, OWASP ids), so no `evals/`
  directory is needed at runtime. After editing `evals/seeds`, run
  `npm run seeds:sync -w packages/planner`; a test fails while it is stale.

Callers: the dashboard's "Plan now", `npm run plan:preview -w apps/worker`, and
the nightly cron's post-run re-plan (`nightly:worker`).
