# AgentForge Operator Dashboard

React app on the TanStack stack (Start, Router, Query, Table, Form). It is the
operator surface described in ARCHITECTURE.md Section 15.1: findings ticket
tracker, tonight's queue, run history and morning report, coverage heatmap,
resilience trend, cost, Judge health, approvals, and the Orchestrator chat.

## Build order this week

- **Tue (v1, read-only):** findings list, run history, coverage table, cost panel.
- **Wed (v2):** ticket status workflow, assignee, "Re-check tonight", tonight's
  queue with reorder and remove, morning report.
- **Thu (v3):** approvals queue, resilience trend, agent activity feed,
  `needs_review` resolution, and the Orchestrator chat with confirm-before-enqueue.

## Running

```bash
npm ci                                                  # from the repo root
DATABASE_URL=postgres://... npm run dev -w apps/dashboard   # live data, http://127.0.0.1:3100
npm run dev:fixtures -w apps/dashboard                  # demo data, no database needed
npm test -w apps/dashboard                              # unit + component tests
npm run typecheck -w apps/dashboard
```

| Variable | Meaning |
|----------|---------|
| `DASHBOARD_DATA_SOURCE` | `postgres` (default) or `fixtures`. There is no silent fallback: Postgres mode without `DATABASE_URL` fails at the first request. Fixture mode shows a "Demo data" badge in the sidebar. |
| `DATABASE_URL` | Platform Postgres, migrated with `npm run migrate up` from the repo root. |
| `NIGHTLY_BUDGET_USD` | Tonight's budget envelope for the queue view (default 25). |
| `COVERAGE_TARGET_ATTEMPTS` | Attempts a high-risk cell needs to count toward M5 (`target_attempts`, ARCHITECTURE.md 7.2; default 20). |
| `NIGHTLY_CRON`, `NIGHTLY_TIMEZONE` | Used to work out tonight's run date for `requested_for` (defaults `0 1 * * *`, `America/Chicago`). |

## Data access

Components use TanStack Query hooks (`src/lib/queries.ts`, `src/lib/mutations.ts`)
over `src/lib/data-source.ts`, which calls TanStack Start server functions
(`src/lib/server-fns.ts`). On the server, `src/server/runtime.ts` picks a
`DashboardRepository`:

- `src/server/pg-repository.ts` reads and writes the platform tables
  (ARCHITECTURE.md Section 14.3). Status and assignee changes update `exploits`;
  "Re-check tonight" validates the `RerunRequest v1` and inserts it into
  `operator_requests`; removing a queued request sets its status to `cancelled`.
- `src/server/fixture-repository.ts` serves the synthetic data in
  `src/lib/fixtures.ts`, in memory until the server restarts.

Both run the same contract suite (`src/server/__tests__/repository-contract.ts`).
The Postgres run needs a disposable, migrated database and truncates every
platform table, so never point it at a shared one:

```bash
DASHBOARD_TEST_DATABASE_URL=postgres://af:af@127.0.0.1:54339/af_dashboard_test npm test -w apps/dashboard
```

How the read models are derived:

- **Ticket confidence** is the strongest successful verdict in the exploit's
  family (`family_ids` plus matching fingerprint). **Last verdict** comes from
  the family's most recent verdict; **last verified version** from the newest
  `regression_results` row, falling back to the latest verdict's version.
- **Run history** counts attempts and the latest verdict per attempt through
  `campaigns.nightly_run_id`. New tickets, regressions, the trace link, and the
  **morning report** come from `nightly_runs.summary`, validated as
  `NightlyRunSummary v1` from `@agentforge/contracts`. A missing or invalid
  summary (logged) means derived counts and no report; new tickets are then
  exploits created during the run.
- **Coverage** reads `coverage_snapshots` for the newest target version, and is
  computed live from `attempts` and `exploits` until the Orchestrator has
  written a snapshot for that version. The cell list is exactly `listTaxonomyCells()` from
  `@agentforge/contracts` (AttackTaxonomy v1): untested cells show zero
  attempts, rows outside the taxonomy are dropped with a logged count, and
  categories not in `PRD_CATEGORIES` are labelled as outside the PRD set. The
  taxonomy is imported on the server only, because the contracts entry also
  loads the Node-only validators; browser code uses type-only imports.
  The heatmap marks untested gaps in text.
- **M5** (KEY_METRICS.md) is shown on the heatmap: the six PRD cells
  THREAT_MODEL.md rates high risk are outlined (`src/server/m5.ts`); a cell is
  covered with at least `COVERAGE_TARGET_ATTEMPTS` attempts, at least one
  variant family exercised, and a run in the last 7 days. The two misinformation
  high cells get a dashed outline and are excluded from the fraction. Families
  come from `coverage_snapshots.families_exercised` when that column exists,
  otherwise they are counted live: distinct lineage roots (via
  `parent_attempt_id`) among each cell's variant attempts.
- **Tonight's queue** drains `ORDER BY position NULLS LAST, created_at`. Re-checks
  are appended at the end with a stored `estimated_cost_usd`; requests without
  a stored estimate show a family-size estimate (reruns) or $0 (campaigns).
- **Cost** is `nightly_runs.spend_usd` per run and `agent_events.cost_usd` per
  agent over 30 days; `agent = 'target'` is the Co-Pilot's own spend.

## Conventions

Function components and hooks only. Testing Library for component tests. Tickets
are rows in the `exploits` table, not a separate system.
