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
npm ci                              # from the repo root
npm run dev -w apps/dashboard       # http://127.0.0.1:3100
npm test -w apps/dashboard          # component tests (jsdom + Testing Library)
npm run typecheck -w apps/dashboard
```

## Data access

**v1 reads synthetic fixtures.** `src/lib/fixtures.ts` holds typed in-memory
data and `src/lib/data-source.ts` is the only module that reads it. Components
use the TanStack Query hooks in `src/lib/queries.ts`, and route loaders prime the
same queries. Moving to live data means replacing the bodies in
`data-source.ts` with server function calls; nothing else changes.

Target design:

Server functions (TanStack Start) query the platform Postgres through the shared
`@agentforge/db` package. There is no separate REST API; TanStack Query handles
client fetching and cache invalidation after operator actions.

## Conventions

Function components and hooks only. Testing Library for component tests. Tickets
are rows in the `exploits` table, not a separate system.
