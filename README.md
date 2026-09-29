# AgentForge

A multi-agent adversarial evaluation platform for the OpenEMR Clinical Co-Pilot.
It runs a red team every night and on demand: it generates and mutates attacks,
judges them with an independent judge, files confirmed exploits as tickets,
writes vulnerability reports, and re-tests fixes as regressions. The full design
and the alternatives considered are in [ARCHITECTURE.md](./ARCHITECTURE.md); the
decision deck is [ARCHITECTURE_DECK.html](./ARCHITECTURE_DECK.html).

## Layout

This is an npm workspaces monorepo (Node 22+, TypeScript).

| Path | What it is |
|------|-----------|
| `contracts/` | Published versioned JSON Schema contracts (`<name>/v1.json`), per the PRD. |
| `packages/contracts` | TypeScript types and Ajv validators for those schemas. |
| `packages/db` | Postgres schema (migrations) and connection config. |
| `apps/worker` | The agent platform: model router, agents, Target Adapter, regression harness. |
| `apps/dashboard` | Operator dashboard (React + TanStack Start/Router/Query/Table/Form). |
| `evals/` | Adversarial test suite and seed cases, mapped to OWASP categories. |

## Getting started

```bash
cp .env.example .env      # fill in per-role Anthropic keys and DATABASE_URL
npm install
npm test                  # runs the Vitest suite across workspaces
npm run typecheck         # composite tsc -b build
```

To create the database schema against a running Postgres:

```bash
DATABASE_URL=postgres://agentforge:agentforge@localhost:5432/agentforge \
  npm run migrate up
```

## Execution model

The platform runs one scheduled nightly run (default 01:00 CT) inside a budget
envelope, draining an operator-managed queue: reruns first, then regressions
owed to a changed target, then coverage-driven campaigns. Operators queue work
and change ticket status from the dashboard; "Run now" covers demos and urgent
re-checks. See ARCHITECTURE.md Section 7.

## Models

All model calls go to hosted APIs (no local models, no GPU). The attacker uses
deterministic mutation plus Claude (Haiku 4.5 for variants, Sonnet 5.5 for
strategy) behind a refusal detector. An OpenRouter open-weight tier is wired
behind a feature flag for the categories Claude tends to refuse; the model
router seam (`apps/worker/src/models`) makes that a config change.

## Status

Foundation scaffold is in place and tested:

- Contract schemas and validators (Verdict v1, RerunRequest v1) with tests.
- Core database migration (exploits-as-tickets, attempts, verdicts, nightly
  runs, operator queue, chat, audit, ground truth).
- Model-router provider seam with tier selection and refusal detection.
- Dashboard ticket helpers.

Next: Target Adapter (Co-Pilot + OpenEMR clients), detectors, the Judge, and
the nightly Orchestrator, then the dashboard views in the Tue/Wed/Thu order in
`apps/dashboard/README.md`.
