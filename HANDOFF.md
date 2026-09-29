# Handoff to the agentforge orchestrator

Written 2026-09-29T19:42Z by the standalone lead session (standalone-1). From here on the project orchestrator (agentforge-3) coordinates workers, merges, and pushes. The standalone session stops spawning and merging.

## Read first

1. `ARCHITECTURE.md` (v0.4): the plan of record. Sections 2.4 (decisions D1–D7), 7.0 (nightly cadence), 15.1 (dashboard), 20 (day-by-day schedule).
2. `README.md`: layout, install (`npm ci` only; npm 10.9 arborist bug on fresh installs, documented there), Postgres setup.
3. The PRD is the attached PDF in `.ao/attachments/` of session standalone-1; its key facts are captured in ARCHITECTURE.md Section 2.

## State of main (`f3ec609`, pushed to origin)

- 71 tests pass across 12 files; `npx tsc -b` clean; `npm audit` clean.
- `packages/contracts` + `/contracts`: Verdict, RerunRequest, AttackTranscript, DetectorResult, CampaignPlan v1 with Ajv validators.
- `packages/db`: core migration verified up/down/up on Postgres 16 (node-pg-migrate 9).
- `apps/worker`: model router with provider seam (OpenRouter tier feature-flagged for Thursday), refusal detector, Target Adapter (Co-Pilot + OpenEMR clients, allowlist, scoped token, transport with backoff), four deterministic detectors.
- `apps/dashboard`: runnable TanStack Start app, v1 read-only panels (Findings, Run history, Coverage, Cost) on typed fixtures behind TanStack Query, Testing Library tests. Start: `npm run dev -w apps/dashboard`.

## Workers (both spawned by standalone-1, both told: no PRs, push branch to origin, small commits)

| Session | Branch | Owns | Current task | Unmerged commits now |
|---|---|---|---|---|
| agentforge-1 (agentforge-agents) | `ao/agentforge/agents` | `apps/worker`, `packages/*`, `contracts/`, `evals/` | Judge stages 1–2 live against the deployed Co-Pilot; seed evals in `evals/` across 3+ categories with OWASP mapping (the one REQUIRED engineering deliverable); `THREAT_MODEL.md`; `apps/worker/README.md` documenting discovered Co-Pilot routes | 4 |
| agentforge-2 (agentforge-dashboard) | `ao/agentforge/dashboard` | `apps/dashboard` only | Dashboard v2 on fixtures: ticket status workflow, assignee, Re-check tonight, tonight's queue (reorder/remove), morning report | 4 |

Both were told to `git fetch origin && git merge origin/main` before their next commit. Integration so far was merge --no-ff into main by the lead, verified in a detached worktree (`npm ci`, `npm test`, `npx tsc -b`) before merging. Lockfile conflicts: regenerate with `npx -y npm@latest install` (npm 10.9 cannot rebuild the tree).

## Environment

- Postgres 16 container `agentforge-pg` on localhost:54329 (label ao.session=standalone-1, so it is reaped when standalone-1 ends; start your own with the same label pattern if needed).
- Target: Co-Pilot https://copilot-evidence-production.up.railway.app/ , OpenEMR https://openemr-production-ef61.up.railway.app/ (synthetic data only). Co-Pilot source lives in the separate project `openemr-base-clean` at /Users/joealfaro/Documents/openemr-base-clean (`copilot-service/`).
- A verification dev server may still be running from /tmp/af-dash on port 5180; kill it freely. Temp worktrees /tmp/af-dash and /tmp/af-agents are disposable (`git worktree prune`).

## Tuesday (early submission, 11:59 PM CT) gates still open

- Judge running live against the deployed target (agents worker, in progress)
- `./evals/` with results from 3+ attack categories, OWASP-mapped (agents worker)
- `THREAT_MODEL.md` with ~500-word summary (agents worker)
- `KEY_METRICS.md`, `USERS.md` (unassigned; depend only on ARCHITECTURE.md)
- Self-hosted Langfuse on Railway and Co-Pilot instrumentation (needs the user's Railway access)
- Demo video (user)
- Deployed platform URL submitted with the checkpoint

## Standing decisions not to relitigate

TypeScript + LangGraph.js; React dashboard on TanStack (Start/Router/Query/Table/Form), never Next.js; Claude attacker (Haiku variants, Sonnet strategy) with OpenRouter tier added Thursday behind a flag; hybrid Judge with detectors authoritative; nightly cadence + operator queue + Run now; self-hosted Langfuse; typed JSON Schema contracts persisted in Postgres; only OWASP mapping is a required engineering deliverable, the rest of the PRD's optional list is triaged in ARCHITECTURE.md Section 2.2.
