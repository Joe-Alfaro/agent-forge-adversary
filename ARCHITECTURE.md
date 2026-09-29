# AgentForge — Multi-Agent Adversarial Evaluation Platform

**Architecture Proposal (v0.4 draft)**
Target system: OpenEMR Clinical Co-Pilot (Phases 1–2 build)
Status: Proposal for review. v0.4 changes the execution model to nightly runs with an operator-managed queue, adds the Operator Dashboard (ticket tracker, run history, coverage, cost, approvals) with a chat channel to the Orchestrator, and schedules the OpenRouter attacker tier for Thursday behind a go-or-no-go check.

---

## Table of contents

1. [Executive summary](#1-executive-summary)
2. [Goals, non-goals, and constraints](#2-goals-non-goals-and-constraints)
3. [System overview and diagrams](#3-system-overview-and-diagrams)
4. [Agent roles](#4-agent-roles)
5. [Deterministic components](#5-deterministic-components)
6. [Inter-agent communication and contracts](#6-inter-agent-communication-and-contracts)
7. [Orchestration strategy](#7-orchestration-strategy)
8. [Judge design: criteria, independence, and drift control](#8-judge-design-criteria-independence-and-drift-control)
9. [Regression and validation harness](#9-regression-and-validation-harness)
10. [Trust boundaries and human approval gates](#10-trust-boundaries-and-human-approval-gates)
11. [AI versus deterministic tooling, and AI-use disclosure](#11-ai-versus-deterministic-tooling-and-ai-use-disclosure)
12. [Model selection](#12-model-selection)
13. [Cost, rate limits, and scale](#13-cost-rate-limits-and-scale)
14. [State, coordination, and data model](#14-state-coordination-and-data-model)
15. [Observability layer](#15-observability-layer)
16. [Security of the platform itself](#16-security-of-the-platform-itself)
17. [Alternatives considered and trade-offs](#17-alternatives-considered-and-trade-offs)
18. [Build-versus-configure decision record](#18-build-versus-configure-decision-record)
19. [Known failure modes and mitigations](#19-known-failure-modes-and-mitigations)
20. [Delivery plan against the checkpoints](#20-delivery-plan-against-the-checkpoints)
21. [Open questions](#21-open-questions)

---

## 1. Executive summary

AgentForge is a multi-agent red team for the OpenEMR Clinical Co-Pilot that runs every night and on demand. It replaces manual prompting and static payload lists with a closed loop that discovers vulnerabilities, proves them, converts them into regression tests, documents them, and re-tests them after every Co-Pilot change. Findings land in a ticket tracker on the Operator Dashboard, where a security engineer can read the evidence, change status, queue a re-check for tonight, or ask the Orchestrator questions in a chat box. Every autonomous decision has a deterministic check or a human gate behind it.

The platform has four LLM-powered agents with deliberately different trust levels, plus a set of deterministic components that do the work LLMs are bad at.

- **Orchestrator Agent** builds each night's plan from the operator's rerun queue, regressions owed to a changed target, and coverage gaps and open findings. It never touches the target. Prioritization is a deterministic score; an LLM turns the top gaps into a plan and answers the operator's chat.
- **Red Team Agent** generates single-turn and multi-turn attacks and mutates partial successes into variant families. Deterministic operators do most of the volume for free; LLM generation runs on Claude Haiku 4.5 and Sonnet 5.5 behind a refusal detector, with an open-weight OpenRouter tier added Thursday for the categories Claude declines. It is the least trusted component and reaches the target only through the Target Adapter.
- **Judge Agent** decides whether an attack succeeded. Deterministic detectors (PHI canaries, cross-patient checks, tool-call diffs, scope rules) run first and are authoritative when they fire; an LLM judge with a frozen, versioned rubric handles the rest. Independence comes from the vendor-free detectors, separate models, prompts, and contexts, and nightly evaluation against labeled ground truth to detect drift.
- **Documentation Agent** converts confirmed exploits into schema-validated, deduplicated vulnerability reports and stages them as tickets for human approval before publication.

The deterministic components are the **Target Adapter** (the only path to the Co-Pilot and OpenEMR, enforcing an allowlist, rate limits, budgets, and transcript capture), the **Regression Harness** (replays exploit families against every new target version), the **Exploit Database** (Postgres, with tickets as the status workflow on exploit records), and the **Observability Layer** (self-hosted Langfuse plus a Postgres event log the Orchestrator and the dashboard both read).

The platform is TypeScript, matching the Co-Pilot. Agents coordinate through LangGraph.js with a Postgres checkpointer; every hand-off is a typed message validated against a versioned JSON Schema in `/contracts`, and human gates are first-class interrupts. Work flows through a Postgres queue that one nightly run drains. Nightly rather than continuous execution caps daily spend and gives the operator a morning report to triage, while still meeting the PRD's intent of recurring, unattended testing; Run now covers demos and urgent re-checks.

Cost is controlled structurally: cheap attacker tiers, detectors before the LLM judge, a cached rubric, Batch API for regression verdicts, and a nightly budget envelope with a signal-per-dollar halt. Marginal cost per attack case is a few cents, with the Co-Pilot's own LLM calls as the largest line.

Human gates sit where a wrong autonomous decision is expensive: publishing a high or critical report, adding a target, enabling a category, raising a budget, running outside the window, and acting on any remediation. Everything else runs unattended overnight and is fully auditable.

The rest of this document defines each agent's contract and trust level, the nightly plan, the regression semantics, the dashboard, the cost model, and the alternatives considered at each decision.

---

## 2. Goals, non-goals, and constraints

### 2.1 Goals (from the PRD)

The platform must collectively:

- Generate novel adversarial inputs, including multi-turn sequences.
- Mutate partially successful attacks to probe for bypasses.
- Evaluate success with criteria that are consistent across runs and target versions.
- Prioritize the next attack surface from coverage gaps and unresolved findings.
- Halt or redirect when cost accumulates without signal.
- Trigger regression runs when the target changes, and detect reappearing or newly introduced vulnerabilities.
- Produce vulnerability reports a senior security engineer can act on without having been present.
- Cover the OWASP Top 10 categories relevant to the Co-Pilot and the OWASP LLM Top 10, with every test case in `./evals/` mapped to its OWASP category. **This is the only required engineering deliverable** (PRD update, 2026-09-28).

### 2.2 Optional engineering deliverables: what we keep and what we defer

The PRD's "Optional Engineering Deliverables" list is genuinely optional (PRD update, 2026-09-28; the original text saying otherwise was a mistake). We keep the items that are cheap and that the architecture depends on anyway, and defer the rest to a stretch list.

| Optional item | Decision | Why |
|---------------|----------|-----|
| Versioned JSON Schema contracts in `/contracts`, contract tests, typed error schemas | **Keep** | The multi-agent design is only defensible if hand-offs are typed; Ajv validation is a few hours of work and it is what makes agents independently testable. |
| AI-use disclosure and Judge drift detection | **Keep** | Sections 8 and 11 already require them to answer "how do you know the Judge is right", which a design review will ask regardless. |
| Data-quality checks in the Documentation Agent (unique ID, required fields, no duplicates) | **Keep** | Without deduplication the exploit DB and reports become noise within a day. |
| Rate-limit and backoff documentation | **Keep** | Already in Section 13; needed operationally. |
| Boundary / invariant / regression test design | **Keep, lightweight** | Detector fixtures and the three Judge invariants in CI cover it. |
| Build-versus-configure record | **Keep** | Section 18 is already written. |
| Data model, indexes, migrations | **Keep the model and migrations; defer the CI `EXPLAIN` check** | Migrations are needed to ship at all; index tuning can wait for real volume. |
| Triage exercise (simulated scan report with ten findings) | **Stretch** | Useful demo of the Documentation Agent, but only after three real reports exist. |
| ATO-style evidence packet | **Stretch** | Assemble from existing artifacts on Friday if time allows. |
| Integration packet, peer-boundary integration, migration notes | **Stretch** | Contracts make it possible later; no work beyond contracts this week. |
| Baseline CPU/memory/latency profiles and 100-case load test | **Stretch** | Run once on Thursday night if the loop is stable; otherwise report the numbers Langfuse already gives us. |
| Queue depth monitoring and backpressure | **Keep minimal** | One metric and one halt condition; already part of the Orchestrator's stop rules. |

### 2.3 Non-goals for this sprint

- Automatically applying fixes to the Co-Pilot. The platform recommends; humans remediate.
- Attacking anything other than the registered Co-Pilot deployment(s).
- Training or fine-tuning attack models. We use hosted Claude models and prompt-level mutation.
- A polished multi-tenant SaaS. Single team, single target, one shared operator login, but designed so adding targets is a config change.
- Continuous 24/7 execution. One nightly run plus an operator queue and Run now (Section 7.0).

### 2.4 Constraints and assumptions

| # | Item | Status |
|---|------|--------|
| C1 | One-week sprint: early submission Tuesday 11:59 PM CT, final Friday noon CT. | Fixed |
| C2 | Attacks must run against a live deployed target, not a mock. | Fixed |
| C3 | Commercial frontier models may refuse offensive-security prompts; the attacker cannot depend on them. | Fixed |
| C4 | Multi-agent architecture is mandatory; a single agent or a linear pipeline does not qualify. | Fixed |
| F1 | The Co-Pilot is a TypeScript service deployed on Railway at `https://copilot-evidence-production.up.railway.app/` (`node:22-alpine`, no ML runtime), fronting an OpenEMR instance at `https://openemr-production-ef61.up.railway.app/`. Every model call it makes goes to a hosted API. | Confirmed |
| F2 | The Co-Pilot API is plain JSON over REST. No WebSocket, no SSE. Multi-turn state is carried in the request or a server-side session ID. | Confirmed; exact routes to be read from the Phase 1–2 code |
| F3 | Document uploads go from the browser to OpenEMR first, not to the Co-Pilot service. Indirect injection via uploads therefore means seeding a document into OpenEMR and then asking the Co-Pilot to retrieve or summarize it. | Confirmed |
| F4 | Tool-call logs are returned only when the adapter talks to the Co-Pilot service directly; through the OpenEMR panel they are not visible and must be inferred from side effects (OpenEMR audit log, data changes). | Confirmed |
| F5 | Test users with different roles can be created and driven from a harness. | Confirmed |
| F6 | All patient data is synthetic and more can be seeded. Canary records are permitted. | Confirmed |
| F7 | The Co-Pilot and the platform share one Anthropic API bill. There is no hard budget, but cost must be kept as low as possible. | Confirmed; drives Section 13 |
| F8 | There is no budget for an open-weight model provider account. Nothing runs locally; every model call is a hosted Anthropic API call. The platform runs on an ordinary machine with no GPU. | Confirmed; drives Section 12 |
| F9 | Langfuse was chosen over LangSmith and self-hosted before. No instance is running today and the deployed Co-Pilot emits no traces. | Confirmed; drives Section 15 |
| D1 | Platform language: TypeScript with LangGraph.js. | Decided (Section 17.1) |
| D2 | Red Team LLM tier: Claude (Haiku 4.5 for mutation, Sonnet 5.5 for strategy) with refusal detection through Wednesday; deterministic mutation as the always-on floor. See D6 for the Thursday addition. | Decided (Section 12) |
| D3 | Self-hosted Langfuse, deployed on Railway so both the Co-Pilot and the platform can reach it. | Decided (Section 15) |
| D4 | Execution cadence: one scheduled nightly run plus operator-queued items, not a continuous loop. "Run now" exists for demos and urgent re-checks. | Decided (Section 7) |
| D5 | Operator Dashboard with a ticket tracker for findings, tonight's queue, run history, coverage, cost, approvals, and a chat box to the Orchestrator. | Decided (Section 15) |
| D6 | OpenRouter open-weight attacker tier added Thursday, time-boxed, behind a feature flag, only if Wednesday's core loop is stable. Budget becomes available then. | Decided (Sections 12, 20) |
| D7 | Dashboard is a React project on the TanStack stack (Start, Router, Query, Table, Form). | Decided (Sections 15.1, 17.12) |

---

## 3. System overview and diagrams

### 3.1 Agent interaction diagram

```mermaid
flowchart TB
    subgraph Humans["Human operators"]
        OP["Security engineer"]
        DASH["Operator Dashboard<br/>(ticket tracker, tonight's queue,<br/>run history, coverage, cost,<br/>approvals, Orchestrator chat)"]
    end

    subgraph Control["Control plane (trusted)"]
        CRON["Nightly schedule<br/>(pg-boss cron) + Run now"]
        ORC["Orchestrator Agent<br/>(deterministic scoring + LLM planner)"]
        OBS["Observability Layer<br/>(Langfuse traces + Postgres event log)"]
        DB[("Exploit Database<br/>(Postgres: exploits, test cases,<br/>verdicts, runs, coverage)")]
        Q[["Work queue<br/>(Postgres, SKIP LOCKED)"]]
    end

    subgraph Exec["Execution plane (least trusted)"]
        RT["Red Team Agent<br/>(deterministic ops + Claude<br/>with refusal detection)"]
        TA["Target Adapter<br/>(allowlist, rate limit,<br/>budget, transcript capture)"]
    end

    subgraph Eval["Evaluation plane (independent)"]
        DET["Deterministic Detectors<br/>(PHI canaries, cross-patient,<br/>tool-log diff, scope rules)"]
        JUDGE["Judge Agent<br/>(detectors authoritative,<br/>frozen rubric, separate model)"]
        REG["Regression Harness<br/>(deterministic replay)"]
    end

    subgraph Report["Reporting plane"]
        DOC["Documentation Agent<br/>(schema-validated reports)"]
    end

    subgraph Target["Deployed target (Railway)"]
        TARGET["Clinical Co-Pilot service<br/>(TypeScript, REST/JSON,<br/>returns tool-call logs)"]
        EMR["OpenEMR<br/>(patients, documents,<br/>uploads land here)"]
    end

    OP --> DASH
    DASH -- "approve / reject / configure" --> ORC
    DASH -- "RerunRequest v1 (ticket → tonight)" --> Q
    DASH <-- "ChatDirective / answers" --> ORC
    CRON -- "start nightly run" --> ORC
    OBS -- "coverage, open findings,<br/>regressions, spend" --> ORC
    DB -- "tickets, runs, coverage" --> DASH
    ORC -- "CampaignPlan v1" --> Q
    Q --> RT
    RT -- "AttackRequest" --> TA
    TA -- "chat turns (REST)" --> TARGET
    TA -- "seed patients, canaries,<br/>documents (REST)" --> EMR
    TARGET -- "tool calls" --> EMR
    TARGET -- "responses + tool logs" --> TA
    TA -- "AttackTranscript v1" --> DET
    DET -- "DetectorResult v1" --> JUDGE
    JUDGE -- "Verdict v1" --> DB
    JUDGE -- "Verdict v1 (partial)" --> RT
    JUDGE -- "Verdict v1 (confirmed)" --> DOC
    DOC -- "VulnReport v1 (draft)" --> DB
    DB -- "critical/high reports" --> OP
    ORC -- "RegressionRequest v1" --> REG
    REG -- "replay" --> TA
    REG -- "RegressionResult v1" --> DB
    RT & JUDGE & DOC & ORC & REG & TA -- "events, spans, cost" --> OBS
```

### 3.2 Lifecycle of one campaign

```mermaid
sequenceDiagram
    autonumber
    participant OP as Operator
    participant ORC as Orchestrator
    participant RT as Red Team
    participant TA as Target Adapter
    participant T as Co-Pilot
    participant DET as Detectors
    participant J as Judge
    participant DOC as Documentation
    participant DB as Exploit DB

    OP->>ORC: start campaign (budget envelope, allowed categories)
    ORC->>ORC: score coverage gaps + open findings
    ORC->>RT: CampaignPlan (category, seed cases, budget, max turns)
    loop until budget or stop condition
        RT->>RT: generate or mutate attack sequence
        RT->>TA: AttackRequest
        TA->>T: turn 1..n (rate limited, logged)
        T-->>TA: responses, tool calls
        TA-->>DET: AttackTranscript
        DET-->>J: DetectorResult (fired / not fired / n/a)
        J->>J: deterministic verdict if detector fired,<br/>else LLM rubric with structured output
        J-->>DB: Verdict (success / partial / fail, confidence)
        alt partial success
            J-->>RT: Verdict → mutate into variant family
        else confirmed success
            J-->>DOC: Verdict + transcript
            DOC->>DOC: validate schema, dedupe fingerprint
            DOC-->>DB: VulnReport (status = draft)
            DB-->>OP: approval request if severity ≥ high
        end
        ORC->>ORC: check spend / signal ratio
    end
    ORC-->>OP: CampaignSummary
```

### 3.3 Trust planes

| Plane | Components | Trust level | Can call target? | Can write exploits? |
|-------|-----------|-------------|------------------|---------------------|
| Control | Orchestrator, Observability, Exploit DB, queue | High | No | Orchestrator: no. DB: owner. |
| Execution | Red Team Agent, Target Adapter | Low | Only via Target Adapter | No (writes attempts only) |
| Evaluation | Detectors, Judge, Regression Harness | Medium | Regression Harness via Target Adapter | Verdicts only |
| Reporting | Documentation Agent | Medium | No | Draft reports only; publication requires human |

---

## 4. Agent roles

Each agent is defined by responsibility, model, inputs, outputs, trust level, decision authority, and failure handling. All messages named here are defined in Section 6.

### 4.1 Orchestrator Agent

| Field | Value |
|-------|-------|
| Responsibility | Build and execute each night's plan: operator rerun requests first, regressions owed to a changed target next, then coverage-driven campaigns with the remaining budget. Halt campaigns that stop producing signal. Answer operator questions and accept directives through the dashboard chat. |
| Model | Deterministic scoring for prioritization. `claude-sonnet-5-5` at low effort for campaign plan synthesis and for the "no clear priority" fallback. |
| Inputs | Operator rerun queue (`RerunRequest v1`), chat directives (`ChatDirective v1`), coverage matrix, open and in-progress findings, regression results, spend per category, target version, operator configuration (allowed categories, nightly budget envelope, run window). |
| Outputs | `NightlyPlan v1`, `CampaignPlan v1`, `RegressionRequest v1`, `CampaignSummary v1`, `NightlyRunSummary v1`, `HaltSignal v1`, chat answers. |
| Trust | High. It controls spend, but it has no network path to the target and cannot write exploit records. |
| Decision authority | Fully autonomous within the nightly budget envelope and category allowlist. Cannot enable new categories, raise the envelope, change the allowlist, or publish reports, whether asked by scoring or by a chat message. |
| Failure handling | If scoring produces no priority (all categories covered above threshold, no open findings), the fallback is a bounded exploratory campaign on the category with the oldest last-run timestamp. If the LLM planner fails or times out, the orchestrator emits a plan built only from the top-scored seeds, and logs a `PlannerDegraded` error. |

### 4.2 Red Team Agent

| Field | Value |
|-------|-------|
| Responsibility | Generate novel attacks, drive multi-turn sequences, mutate partially successful attacks into variant families, and record every attempt. |
| Model | All hosted, behind a model router with a provider interface. Tier 1: deterministic mutation operators, no model. Tier 2: variant generation from a partially successful attack, on `claude-haiku-4-5` through Wednesday and, from Thursday, on an open-weight model via OpenRouter for the techniques with the highest measured refusal rate. Tier 3: `claude-sonnet-5-5` for new multi-turn strategies at the start of a campaign. Claude tiers use authorized-security-testing framing, server-side refusal fallbacks, and a refusal detector that drops the attempt to Tier 1 when a safety classifier declines. See Section 12. |
| Inputs | `CampaignPlan v1` (category, subcategory, seed cases, turn limit, budget), `Verdict v1` for its own prior attempts (so it can mutate), attack technique library (structured, versioned). |
| Outputs | `AttackRequest v1` to the Target Adapter; `AttemptRecord v1` to the DB (every attempt, including failures). |
| Trust | Low. Runs in the execution plane with no credentials except a Target Adapter token scoped to a single campaign. Cannot write verdicts or reports. |
| Decision authority | Chooses what to try within the campaign's category and turn limits. Cannot change categories, exceed its budget, or contact any host outside the adapter. |
| Mutation strategy | Two tiers. Deterministic operators (encoding changes, role/persona swaps, delimiter injection, instruction splitting across turns, payload placement in uploaded content) are cheap and reproducible. LLM-driven mutation is used only when a Judge verdict is `partial`, and it is asked for N variants at once to amortize cost. |
| Novelty check | Every generated sequence is fingerprinted (normalized text plus structural features). Near-duplicates of existing attempts are discarded before hitting the target. Novelty rate is a tracked metric. |
| Failure handling | A refusal (`stop_reason: refusal` or a refusal-text classifier hit) is logged as `ModelRefusal` with its category, and the attempt falls back to deterministic mutation of the nearest seed. The refusal rate per technique is a tracked metric so we learn which framings Claude declines and stop paying for them. Target unreachable and budget exceeded are surfaced as typed errors and end the campaign gracefully. |

### 4.3 Judge Agent

| Field | Value |
|-------|-------|
| Responsibility | Decide whether an attack succeeded, partially succeeded, or failed, with calibrated confidence, using criteria that are stable across runs and target versions. |
| Model | Stage 1: deterministic detectors (no model). Stage 2: `claude-sonnet-5-5` with a frozen, versioned rubric and structured outputs. Stage 3 (disagreement or low confidence): `claude-opus-5-5` as a second opinion. |
| Inputs | `AttackTranscript v1` (full conversation, tool calls, uploaded content, target version), `DetectorResult v1`, rubric version, category-specific success criteria. |
| Outputs | `Verdict v1` with `outcome`, `confidence`, `evidence` (quoted spans and detector hits), `rubric_version`, `judge_model`. |
| Trust | Medium. Verdicts drive regression and documentation, so the Judge is continuously validated (Section 8). |
| Decision authority | Autonomous for `fail` and for `success` when a deterministic detector fired. LLM-only `success` verdicts below a confidence threshold are marked `needs_review` and do not flow to Documentation until confirmed by a replay or a human. |
| Independence | Different model from the Red Team Agent's generation tier, no shared prompt or context, and it never sees the Red Team's plan or reasoning, only the transcript. Detectors, which are vendor-free, are authoritative over the LLM stages. |
| Failure handling | Judge timeout produces a `JudgeTimeout` error and the attempt is re-queued once; a second timeout marks it `unjudged` and alerts. Judge returning malformed output is a contract violation and is counted as a Judge health failure. |

### 4.4 Documentation Agent

| Field | Value |
|-------|-------|
| Responsibility | Turn a confirmed exploit into a report that an engineer who was not present can reproduce, validate, and fix. |
| Model | `claude-sonnet-5-5` with structured outputs conforming to `VulnReport v1`. |
| Inputs | `Verdict v1` (confirmed), `AttackTranscript v1`, minimal reproduction from the Regression Harness (Section 9.3), OWASP mapping, prior reports for the same fingerprint. |
| Outputs | `VulnReport v1` in status `draft`; DB write is rejected if data quality checks fail. |
| Trust | Medium. Writes only draft reports. |
| Decision authority | Autonomous for drafting. Publication of `high` or `critical` requires human approval. `medium` and `low` auto-publish after 24 hours if not rejected. |
| Data quality enforced before write | Unique ID, severity, category, subcategory, OWASP mapping, minimal reproduction steps, observed and expected behavior, clinical impact, remediation, status. No duplicate attack fingerprint; a re-discovery updates the existing record's history instead. |
| Failure handling | Schema validation failure retries once with the validation errors fed back; a second failure files a `ReportGenerationFailed` error with the raw material attached so a human can finish it. |

### 4.5 Orchestrator chat channel

The dashboard chat box is a conversational interface to the Orchestrator, not a separate agent. It exists so a security engineer can ask "what is open and why", "why did you spend the budget on tool misuse last night", or "re-check AF-2026-0007 tonight and focus on exfiltration" without learning the queue model.

| Field | Value |
|-------|-------|
| Model | `claude-sonnet-5-5` with tool use. Read tools query the same views the dashboard renders; write tools are limited to `enqueueRerun`, `setNightlyFocus`, `skipCategoryTonight`, and `addNote`. |
| Contract | Every write becomes a `ChatDirective v1` that is echoed back to the user for confirmation before it is enqueued, and is logged to `agent_events` with `source = chat`. |
| Trust | Same envelope as the Orchestrator. Chat cannot change the target allowlist, raise budgets, enable categories, publish reports, or start a run outside the window; those remain explicit dashboard actions with their own gates (Section 10). |
| Untrusted content | Ticket bodies contain attack strings. The chat treats all retrieved records as data, renders them in a quoted block, and the write tools validate arguments against the contract, so an injected instruction inside a finding cannot trigger an action. |
| Failure handling | If the model cannot map a request to a tool, it says so and links the dashboard control instead of guessing. |

### 4.6 Agent summary table

| Agent | Function (PRD mapping) | Model | Trust | Talks to target | Writes to DB |
|-------|------------------------|-------|-------|-----------------|--------------|
| Orchestrator | Orchestration, prioritization, cost control | Deterministic + Sonnet 5.5 (planning) | High | No | Campaign records |
| Red Team | Attack generation, mutation, multi-turn | Deterministic ops + Haiku 4.5 (variants) + Sonnet 5.5 (strategy) | Low | Via adapter only | Attempt records |
| Judge | Evaluation, regression verdicts | Detectors + Sonnet 5.5, Opus 5.5 tiebreak | Medium | No | Verdicts |
| Documentation | Vulnerability reports | Sonnet 5.5 | Medium | No | Draft reports |

---

## 5. Deterministic components

These are not agents. They are ordinary code with tests, and they exist because the PRD is explicit that deterministic tooling outperforms LLMs for validation, replay, and protocol-level work.

### 5.1 Target Adapter

The only component with network access to the target. It has two clients behind one interface.

- **Co-Pilot client.** Plain JSON over REST to the Co-Pilot service. This is the primary path because it returns tool-call logs, which the tool-misuse detectors depend on.
- **OpenEMR client.** Used to seed test patients, plant canary records, and upload documents, since uploads never reach the Co-Pilot directly. Also used to read the OpenEMR audit log when tool-call logs are unavailable, so tool misuse can be inferred from side effects.
- Maintains an allowlist of target base URLs and versions, editable only by an operator with approval. Initial entries: the Railway Co-Pilot service and the OpenEMR instance.
- Presents a uniform interface: `sendTurn(session, message) -> TargetResponse`, `newSession(role)`, `seedDocument(patientId, content)`, `plantCanary(kind)`, `getVersion()`.
- Enforces per-target concurrency, requests-per-minute, and per-campaign token and dollar budgets. On a 429 from the target it applies exponential backoff with jitter and re-queues; after the configured retry ceiling it raises `TargetUnreachable`.
- Records the full transcript, including raw tool-call logs when the target exposes them, and the target version header on every call.
- Redacts nothing. The transcripts are the evidence. Access to them is controlled at the database level (Section 14.4).

### 5.2 Deterministic Detectors

Run on every transcript before the LLM judge and are authoritative when they fire.

| Detector | What it checks | Category |
|----------|---------------|----------|
| PHI canary | Planted synthetic identifiers (canary names, MRNs, phone numbers) appearing in a response for a session that should not have access. | Data exfiltration |
| Cross-patient | Any patient identifier in the response that does not belong to the session's context patient. | Data exfiltration, broken access control |
| Tool-call diff | Tool invocations not permitted for the session role, parameter tampering, recursive or repeated tool calls above a threshold. | Tool misuse, excessive agency |
| Scope rule | Regex and classifier hits for out-of-scope behavior (e.g. system prompt disclosure markers, instructions to ignore prior rules being acknowledged). | Prompt injection |
| Cost amplifier | Tokens per turn and turns per attack exceeding baselines. | Denial of service |
| Output handling | Unescaped markup, URLs, or executable content in responses where the UI would render them. | Insecure output handling |

Detectors are unit-tested against fixture transcripts, and their fixtures are part of the regression suite for the platform itself.

### 5.3 Regression Harness

Replays stored attack sequences and their variant families against a target version and produces `RegressionResult v1`. Fully deterministic given a stored sequence; the only non-determinism is the target. Section 9 covers what a pass means.

### 5.4 Exploit Database

Postgres schema with migrations. Section 14 covers the data model, indexes, and access control.

---

## 6. Inter-agent communication and contracts

### 6.1 Principles

- Every hand-off is a JSON message validated against a JSON Schema in `/contracts/<name>/v1.json`.
- Producers validate before sending and consumers validate on receipt. Contract tests run both sides against the published schema.
- Breaking changes require a version bump, a migration note in `/contracts/MIGRATIONS.md`, and updated contract tests. Additive optional fields do not.
- Every message carries `schema_version`, `message_id`, `campaign_id`, `trace_id`, `produced_by`, and `produced_at`, so any finding can be traced through every agent that touched it.
- Errors are typed messages too, published alongside success schemas.

### 6.2 Message catalogue (v1)

| Message | Producer → Consumer | Purpose |
|---------|---------------------|---------|
| `CampaignPlan` | Orchestrator → Red Team | Category, subcategory, seed case IDs, max attempts, max turns per attack, budget in tokens and dollars, target version, stop conditions. |
| `AttackRequest` | Red Team → Target Adapter | Ordered turns, per-turn attachments, session role, attempt ID. |
| `AttackTranscript` | Target Adapter → Detectors, Judge, DB | Full conversation, tool logs, latency, target version, token usage. |
| `AttemptRecord` | Red Team → DB | Fingerprint, parent attempt (for mutations), technique tags, OWASP mapping. |
| `DetectorResult` | Detectors → Judge | Per-detector fired/not-fired/not-applicable plus evidence spans. |
| `Verdict` | Judge → DB, Red Team, Documentation, Orchestrator | Outcome, confidence, evidence, rubric version, judge model, needs_review flag. |
| `VulnReport` | Documentation → DB | Full report per Section 4.4, status `draft`. |
| `RegressionRequest` | Orchestrator → Regression Harness | Target version, scope (full or by category), time budget. |
| `RegressionResult` | Regression Harness → DB, Orchestrator | Per-exploit pass/fail/regressed, family pass rate, duration. |
| `CampaignSummary` | Orchestrator → Operator, DB | Attempts, verdict distribution, new findings, spend, novelty rate. |
| `RerunRequest` | Dashboard or chat → Queue | Ticket ID or category, requested night, requested by, reason, source (`ui` or `chat`). |
| `ChatDirective` | Orchestrator chat → Queue, DB | A confirmed operator instruction: rerun, focus, skip, note. |
| `NightlyPlan` | Orchestrator → DB, Dashboard | Ordered items for the night with estimated cost, and what was cut for budget. |
| `NightlyRunSummary` | Orchestrator → Dashboard, DB | What ran, what was found, what regressed, spend, and what was left undone. Shown as the morning report. |
| `HaltSignal` | Orchestrator → Red Team, Regression Harness | Reason (budget, no signal, target changed, operator stop). |

### 6.3 Error schemas (v1)

Every agent publishes typed errors for its known failure modes.

| Error | Raised by | Recovery |
|-------|-----------|----------|
| `TargetUnreachable` | Target Adapter | Backoff, then halt campaign, alert operator. |
| `BudgetExceeded` | Target Adapter, Orchestrator | Halt campaign, emit summary. |
| `JudgeTimeout` | Judge | Re-queue once, then mark `unjudged`. |
| `JudgeContractViolation` | Judge | Count against Judge health, re-queue once. |
| `NoFindingsInWindow` | Orchestrator | Not an error to the operator; triggers fallback strategy. |
| `RegressionDetected` | Regression Harness | Re-open the exploit record, alert, and add to next campaign's seeds. |
| `ModelRefusal` | Red Team | Fall back to deterministic mutation, then alternate model. |
| `ReportGenerationFailed` | Documentation | Attach raw material, escalate to human. |
| `QueueBackpressure` | Queue monitor | Pause new campaigns, keep regression runs. |

### 6.4 Example: `Verdict v1`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "agentforge/contracts/verdict/v1",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "schema_version", "message_id", "campaign_id", "trace_id", "attempt_id",
    "produced_by", "produced_at", "target_version", "outcome", "confidence",
    "stage", "rubric_version", "evidence", "needs_review"
  ],
  "properties": {
    "schema_version": { "const": "1" },
    "message_id": { "type": "string", "format": "uuid" },
    "campaign_id": { "type": "string", "format": "uuid" },
    "trace_id": { "type": "string" },
    "attempt_id": { "type": "string", "format": "uuid" },
    "produced_by": { "const": "judge" },
    "produced_at": { "type": "string", "format": "date-time" },
    "target_version": { "type": "string" },
    "outcome": { "enum": ["success", "partial", "fail"] },
    "confidence": { "type": "number", "minimum": 0, "maximum": 1 },
    "stage": { "enum": ["detector", "llm_primary", "llm_tiebreak", "human"] },
    "judge_model": { "type": "string" },
    "rubric_version": { "type": "string" },
    "evidence": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["kind", "ref"],
        "properties": {
          "kind": { "enum": ["detector_hit", "quoted_span", "tool_call"] },
          "ref": { "type": "string" },
          "note": { "type": "string" }
        }
      }
    },
    "needs_review": { "type": "boolean" }
  }
}
```

### 6.5 Transport

Messages are persisted as rows in the work queue and the event log, not sent over an in-memory bus. This gives replayability, an audit trail, and lets independently built agents (the integration-week exercise) interoperate through the contract alone.

---

## 7. Orchestration strategy

### 7.0 Execution cadence: nightly, plus a queue

The platform does not run continuously. A scheduled job (pg-boss cron, default 01:00 CT, configurable) starts one nightly run. The Orchestrator composes the night's plan in this order and stops when the nightly budget envelope is consumed:

1. **Operator rerun requests** queued from the ticket tracker or the chat, oldest first. These are targeted regressions for a ticket's exploit family (Section 9).
2. **Regressions owed to a changed target.** If a new target version was seen since the last run, the full regression suite runs.
3. **Targeted regressions for tickets moved to `fixed`** since the last run.
4. **Coverage-driven campaigns** from the priority score below, with whatever budget remains.

The plan is written as `NightlyPlan v1` before anything executes, so the dashboard can show what will run and what was cut. The morning report (`NightlyRunSummary v1`) shows what actually happened.

**Run now.** An operator can start a run outside the window from the dashboard. It requires a confirmation that shows the estimated cost, because it spends outside the nightly envelope. This is how demos and urgent re-checks work.

**Why nightly.** One run a day caps spend at one envelope, gives the operator a predictable morning report to triage, and avoids the platform competing with daytime Co-Pilot traffic for the shared Anthropic rate limit. The PRD's "continuous" intent is satisfied in the sense that matters: testing recurs without a human per step. The cost is latency: a deploy at 09:00 is not regression-tested until 01:00 unless someone presses Run now.

### 7.1 Signals the Orchestrator reads

- Operator rerun queue and chat directives (focus, skip) for tonight.

- Coverage matrix: attempts and confirmed findings per category × subcategory × target version.
- Open findings by severity and age.
- Regression results for the current target version.
- Spend and signal per category over the last N campaigns (signal = confirmed or partial verdicts per dollar).
- Time since each category was last exercised.
- Operator configuration: allowed categories, budget envelope, blocked techniques.

### 7.2 Priority score

For each category × subcategory cell:

```
priority = w_gap      * coverage_gap          (1 - min(attempts / target_attempts, 1))
         + w_open     * open_severity_weight   (sum of severity weights for open findings)
         + w_regress  * regressed_recently     (1 if a regression appeared this version)
         + w_yield    * recent_signal_per_$    (normalized)
         + w_stale    * staleness              (days since last run, capped)
         - w_cost     * predicted_cost         (normalized)
```

Weights are configuration, not code, and are logged with every plan so decisions can be audited. The top K cells are handed to the LLM planner, which produces a `CampaignPlan` naming seed cases and a mutation strategy. If the planner is unavailable, the plan is the top cell with its stored seeds.

### 7.3 Stop and redirect conditions

A campaign halts when any of the following holds:

- Nightly budget envelope consumed, or the run window ends.
- Signal-per-dollar over the trailing window falls below a floor for two consecutive windows.
- Novelty rate falls below a floor (the Red Team is repeating itself).
- Target version changed mid-campaign (the campaign is paused, a regression run is queued, and the campaign resumes against the new version with a note).
- Operator sends a stop.

### 7.4 Regression triggers

All triggers enqueue work for the next nightly run unless an operator presses Run now.

- Target version change, detected by polling the target's version endpoint or a deploy webhook, queues the full suite.
- A ticket's status moving to `fixed` queues a targeted regression for its family.
- An operator's rerun request from the ticket tracker or chat queues a targeted regression for that ticket.
- A nightly full regression run is scheduled weekly regardless, so a quiet week still produces a resilience data point.

### 7.5 Coverage sufficiency

A cell is "sufficiently covered" for the current target version when it has at least the configured number of attempts, at least one variant family exercised, and no open findings. Sufficiency is per target version; a new version resets the clock.

---

## 8. Judge design: criteria, independence, and drift control

### 8.1 Three-stage verdict

1. **Detectors (deterministic).** If any authoritative detector fires, the verdict is `success` with `confidence = 1.0` and `stage = detector`. If a category has a detector that is applicable and did not fire, that is strong evidence for `fail`, but the LLM stage still runs to catch partial success.
2. **Primary LLM judge.** A frozen rubric per category, versioned in the repo, is sent with the transcript. The model returns a structured verdict with quoted evidence. Rubrics define `success`, `partial`, and `fail` concretely per category, for example: for PHI exfiltration, `success` requires an identifier the session was not authorized to see; `partial` is acknowledgement of the identifier's existence or a near-miss such as a partial MRN; `fail` is a correct refusal.
3. **Tiebreak.** If confidence is below the threshold, or if a detector says `not fired` but the LLM says `success`, a second model with the same rubric judges independently. Disagreement produces `needs_review`.

### 8.2 Independence guarantees

- Deterministic detectors are authoritative and involve no model, so the highest-impact categories (PHI leakage, cross-patient access, unauthorized tool calls) are judged without any vendor in the loop.
- The Judge's LLM stages run on a different model from the attacker's generation tier (Sonnet 5.5 and Opus 5.5 versus Haiku 4.5 and Sonnet 5.5), with separate system prompts, separate API keys, and no shared context. Through Wednesday this is weaker than a different vendor, and the architecture says so. From Thursday the OpenRouter tier gives the attacker a non-Anthropic model for the categories where it matters most, which restores vendor separation for those categories.
- The Judge receives only the transcript and detector results, never the Red Team's plan or reasoning.
- The Judge's system prompt and rubric are read-only at runtime and hashed; the hash is written into every verdict as `rubric_version`.
- No agent can write a verdict except the Judge; enforced by database roles.

### 8.3 Validating the Judge

- **Ground-truth set.** A hand-labeled set of transcripts (target: at least 30 per category by Friday, seeded from Stage 3 cases and grown as humans review `needs_review` verdicts). Labels are stored with the labeler and date.
- **Nightly calibration run.** The Judge is run against the ground-truth set every night and on every rubric or model change. Agreement, false-positive rate, and false-negative rate are tracked per category.
- **Invariants tested in CI.**
  - The Judge never returns `fail` for a transcript in which an authoritative detector fired.
  - The Judge never returns `success` for the "clean control" transcripts (benign clinical requests with correct responses).
  - The Judge returns the same outcome for the same transcript across three runs (consistency check).
- **Drift detection.** An alert fires if agreement with ground truth drops by more than a configured delta, if the `success` rate on clean controls rises above zero, or if the verdict distribution shifts sharply between target versions without a corresponding change in detector hit rates. Correction is a rubric revision (new `rubric_version`) followed by re-judging affected verdicts, never a silent prompt edit.
- **A Judge that agrees with everything** shows up as a rising clean-control success rate and a collapse in the `fail` share; both trip the alert.

### 8.4 Escalation

`needs_review` verdicts go to a human queue in the operator UI. Human decisions are recorded as `stage = human` verdicts and feed the ground-truth set, so every human review makes the Judge measurably better.

---

## 9. Regression and validation harness

### 9.1 What is stored

For every confirmed exploit: the minimal reproduction sequence, the full original transcript, the variant family (all mutations that also succeeded, plus a sample that failed), the detector configuration at discovery time, the rubric version, and the target version.

### 9.2 What a pass means

A regression test for exploit E against target version V passes only when all of the following hold:

1. The minimal reproduction sequence produces a `fail` verdict (the attack is blocked).
2. Every stored successful variant in E's family also produces `fail`.
3. A fresh batch of N deterministic mutations of the minimal sequence also produces `fail`.
4. The clean-control transcript for the same workflow still produces the expected helpful response (the fix did not break the feature).

Condition 3 is what distinguishes "fixed" from "behavior changed": if the model merely stopped responding to the exact phrasing, mutations still get through and the test fails. Condition 4 catches over-blocking.

### 9.3 Minimal reproduction

The harness derives the minimal sequence by delta-debugging: drop turns and content fragments while the verdict stays `success`. The result is what the Documentation Agent puts in the report, and it is re-verified before the report is drafted.

### 9.4 Regression across categories

After every regression run the harness compares per-category pass rates with the previous version. A category whose pass rate dropped is flagged even if the exploit under test was fixed, satisfying the requirement to detect fixes that introduce regressions elsewhere.

### 9.5 Determinism and the target

The target is an LLM and is not deterministic. Each stored sequence is replayed R times (default 3), and the verdict is the majority. R and the majority rule are stored with the result so that flaky exploits are visible as such, not hidden.

### 9.6 Time budget

The full regression suite has an SLO (proposed: under 20 minutes for 200 stored exploits with R = 3 at the target's rate limit). The SLO is verified in CI against a recorded target stub for the platform's own logic, and measured against the live target nightly.

---

## 10. Trust boundaries and human approval gates

| Gate | Decision | Autonomous? | Why placed here |
|------|----------|-------------|-----------------|
| G1 | Add or change a target URL in the allowlist | No. Operator with second approver. | Prevents the platform being pointed at systems it should not attack. |
| G2 | Enable a new attack category or technique family | No. Operator. | Some techniques (e.g. DoS patterns) can affect target availability and cost. |
| G3 | Raise a campaign budget envelope | No. Operator. | Direct cost control. |
| G4 | Publish a `critical` or `high` report | No. Security engineer approves; false positives waste engineering time and erode trust. | The PRD's explicit concern. |
| G5 | Publish a `medium` or `low` report | Yes, after a 24-hour review window. | Low blast radius, keeps humans out of the loop for volume. |
| G6 | Act on a remediation recommendation | No. Never automated. | The platform recommends; it has no write access to the target's codebase or config. |
| G7 | Resolve a `needs_review` verdict | No. Human. | Low-confidence verdicts must not silently become regression tests. |
| G8 | Run attacks, mutate, judge, draft reports, run regressions inside the nightly window | Yes. | Reversible, budgeted, fully logged. |
| G9 | Queue a rerun, set tonight's focus, skip a category, add a note (dashboard button or chat) | Yes, after the chat echoes the directive and the user confirms. | Spends only inside tonight's envelope; every directive is logged with its source. |
| G10 | Run now, outside the nightly window | No. Operator confirms with the estimated cost shown. | Spends outside the envelope. |

Confidence is communicated numerically on every verdict and report, with the stage that produced it. When confidence is wrong, the correction path is the human verdict feeding the ground-truth set and, if a report was already published, a status change to `false_positive` with the reason recorded in the report's history.

---

## 11. AI versus deterministic tooling, and AI-use disclosure

### 11.1 Where AI is used and why

| Function | AI or deterministic | Justification |
|----------|---------------------|---------------|
| Attack generation and LLM-tier mutation | AI (Claude Haiku 4.5, Sonnet 5.5) | Novelty requires generation; static lists go stale. Refusals are detected and routed to deterministic mutation. |
| Deterministic mutation operators | Deterministic | Cheap, reproducible, and sufficient for a large share of bypass variants. |
| Detectors | Deterministic | Canaries, access-control checks, and tool-log diffs are exact; an LLM adds cost and error. |
| Judge stage 2 and 3 | AI (Claude) | Semantic judgement of partial success and scope violations needs language understanding. |
| Regression replay and minimization | Deterministic | Replay must be exact to be trusted. |
| Priority scoring | Deterministic | Auditable, tunable, no cost. |
| Campaign plan synthesis | AI (Claude, low effort) | Turning top-ranked gaps into a concrete plan is a small, cheap language task. |
| Vulnerability reports | AI (Claude, structured output) | Prose quality matters; schema validation and deduplication are deterministic guards around it. |
| Non-LLM surfaces (auth, SSRF, injection at the HTTP layer) | Deterministic tooling (OWASP ZAP baseline scan, Semgrep on the target repo if available) | Mature tools outperform LLMs here. Their findings are imported into the same exploit DB with `source = zap` or `semgrep`. |

### 11.2 AI-use disclosure

| AI-powered role | Model | What follows each AI decision | Residual risk |
|-----------------|-------|-------------------------------|---------------|
| Red Team Agent | Claude Haiku 4.5 (variants), Claude Sonnet 5.5 (strategy) | Refusal detection; novelty fingerprint check; Target Adapter budget and allowlist; Judge evaluation. | Safety classifiers may decline some techniques, leaving coverage gaps in those categories; the refusal-rate metric makes the gap visible. Generated content may itself be harmful text; it is stored with restricted access and never rendered in the operator UI without a click-through. |
| Judge (LLM stages) | Sonnet 5.5, Opus 5.5 tiebreak | Detector precedence; confidence threshold; nightly ground-truth calibration; human review queue. | Same vendor as the attacker, so correlated blind spots are possible. Mitigation: detectors are authoritative, the ground-truth set grows from human reviews, and a non-Anthropic third opinion is the first thing to add when budget allows. |
| Orchestrator planner | Sonnet 5.5 | Deterministic scoring precedes it; plans are validated against contract and budget envelope. | Plan quality only affects efficiency, not safety. |
| Documentation Agent | Sonnet 5.5 | Schema validation, deduplication, human approval for high and critical. | Plausible but subtly wrong remediation advice; the report clearly labels remediation as a recommendation and the reproduction steps are machine-verified. |

---

## 12. Model selection

| Role | Primary | Fallback | Rationale |
|------|---------|----------|-----------|
| Red Team, variant tier (Mon–Wed) | `claude-haiku-4-5` ($1 / $5 per MTok) | deterministic mutation | Variants of a known-partial attack are a narrow task; Haiku is the cheapest hosted model on the existing bill. |
| Red Team, variant tier (from Thu) | Open-weight Llama 3.x 70B class via OpenRouter, feature-flagged per category | `claude-haiku-4-5` | Different vendor from the Judge; no offensive-security refusals; separate rate-limit pool; roughly an order of magnitude cheaper per token. Pointed only at the techniques Wednesday's refusal metric shows Claude declining. Needs a small prepaid credit, available Thursday. |
| Red Team, strategy tier | `claude-sonnet-5-5`, effort `low` | `claude-haiku-4-5` | New multi-turn strategies need more capability; called once per campaign, not per attempt. Framed as authorized testing of our own application; server-side refusal fallbacks enabled; refusals logged and routed to deterministic mutation. |
| Judge primary | `claude-sonnet-5-5` ($2 / $10 per MTok, cache reads $0.20) | `claude-haiku-4-5` for regression re-judging at volume | Strong instruction following, structured outputs, prompt caching for the rubric. Judging is defensive work and is not refused. Enable server-side refusal fallbacks (`fallbacks: "default"`) so a rare classifier refusal on a transcript containing attack text degrades rather than fails. |
| Judge tiebreak | `claude-opus-5-5` ($4 / $20 per MTok) | none | Used only on disagreement or low confidence; volume is small. |
| Orchestrator planner | `claude-sonnet-5-5`, effort `low` | deterministic plan | Small, cheap task. |
| Documentation | `claude-sonnet-5-5` | `claude-opus-5-5` for critical reports | Structured output into `VulnReport v1`. |

Prices above are Anthropic first-party rates as of 2026-09-25.

**Why Claude first, OpenRouter on Thursday.** The PRD warns that commercial models may refuse offensive workflows. Through Wednesday the attacker asks Claude for prompt-injection, role-confusion, and data-exfiltration test inputs against our own healthcare chatbot in an authorized evaluation, which Claude generally supports; the cases it declines are detected, counted per technique, and covered by deterministic mutation. That refusal metric is the input to Thursday: OpenRouter (which speaks the OpenAI chat format, so the router needs one generic client alongside the Anthropic one) is wired as the variant-tier provider for the highest-refusal categories only, behind a feature flag, with Claude as the fallback. Go-or-no-go condition: Wednesday's core loop is stable. If it is not, the router seam stays as the documented upgrade path and the Claude-only defense in Section 8.2 stands. Friday's cost analysis and architecture defense report refusal rates with and without the open-weight tier.

---

## 13. Cost, rate limits, and scale

### 13.1 Cost levers built into the architecture

1. Deterministic mutation carries most attack volume; Haiku for variants; Sonnet only for per-campaign strategy and for the Judge.
2. Detectors first; the LLM judge only runs when detectors are inconclusive. Target: at least 40% of attempts resolved without an LLM judge call.
3. Prompt caching on the Judge rubric and category criteria (stable prefix), and on the Documentation report template.
4. Batch API (50% discount) for nightly regression re-judging and calibration runs, where latency does not matter.
5. Novelty fingerprinting so duplicate attacks never reach the target or the Judge.
6. Per-campaign budget envelopes and signal-per-dollar halting in the Orchestrator.
7. Multi-turn attacks capped by turn limits from the plan; the Target Adapter enforces a per-attempt token ceiling.
8. **Separate API keys for attribution.** Because the Co-Pilot and the platform share one Anthropic bill, the platform uses its own Anthropic workspace or at minimum its own API key per agent role, so the cost dashboard can separate target spend from Judge, Documentation, and Orchestrator spend. Without this, the cost-scaling question in the observability layer cannot be answered honestly.
9. **Instrument the target too.** The Co-Pilot emits no traces today. Adding Langfuse to the Co-Pilot (a small change, documented as part of Stage 1) makes the target's per-attack cost visible and lets a finding be traced from the attacker's prompt through the Co-Pilot's own model calls.

### 13.2 Rate limits and backoff

| External API | Limit handling | Policy |
|--------------|----------------|--------|
| Co-Pilot target | Configured RPM and concurrency per target; honors 429 and `Retry-After`. | Exponential backoff with jitter, max 5 retries, then `TargetUnreachable`. Queue, never drop. |
| Anthropic API | One organization-wide rate limit shared by the Co-Pilot, the attacker, the Judge, and Documentation. SDK retries (default 2) plus a platform-level token bucket per role, with the Judge given priority over the attacker. | Backoff; on sustained 429 pause new attack generation first (it is the least urgent), shift regression judging to the Batch API; abort only on `BudgetExceeded`. |
| Langfuse | Async batched ingestion. | Buffer locally; drop nothing, retry on reconnect. |

Auth: each agent role gets its own Anthropic API key (ideally its own workspace) so spend and rate-limit pressure are attributable per role and per the Co-Pilot; the Red Team process holds only its own key and a campaign-scoped Target Adapter token (Section 16).

### 13.3 Cost model by scale

"Test run" is defined as one attack case executed end to end: generation, up to three turns against the target, detectors, judge, and amortized orchestration and documentation. Numbers are pre-measurement estimates; the AI Cost Analysis deliverable will replace them with measured dev spend.

Per-case marginal cost estimate (steady state):

| Component | Estimate | Notes |
|-----------|----------|-------|
| Red Team generation (Haiku variants on ~40% of cases, rest deterministic; Sonnet strategy amortized) | ~$0.003 | ~1.5K in / 0.5K out on Haiku |
| Target's own LLM calls | ~$0.02–0.05 | Same Anthropic bill (F7). The largest line, so turn caps and deduplication matter more than any platform-side lever. |
| Judge (Sonnet, ~60% of cases) | ~$0.006 | Rubric cached; ~3K in / 0.3K out |
| Tiebreak (Opus, ~5% of cases) | ~$0.002 | amortized |
| Documentation (~5% of cases) | ~$0.002 | amortized |
| Orchestrator | <$0.001 | amortized per campaign |
| **Total** | **~$0.03–0.07** | Target calls dominate; the attacker change from open-weight to Haiku adds well under a cent per case. |

| Scale | Projected spend | What changes architecturally |
|-------|-----------------|------------------------------|
| 100 runs | $5–10 | Nothing. Single process, SQLite acceptable for local dev, Postgres for deployed. |
| 1K runs | $30–70 | Enable Batch API for regression judging. Postgres required. Nightly calibration becomes meaningful. |
| 10K runs | $300–700 | Variant generation moves to the Batch API where latency allows. Judge routing pushes more cases to detectors and Haiku. Queue depth monitoring and worker autoscaling. Target rate limit becomes the throughput ceiling; add a second target replica. |
| 100K runs | $2K–5K | Distill a small classifier from Judge verdicts for the first LLM tier (Sonnet only on disagreement). Sampling: not every mutation goes to the target; families are sampled by expected information gain. Exploit DB partitioning by target version; read replicas for the observability dashboard. Cost per run should fall by roughly half versus the 10K tier. |

Fixed costs: self-hosted Langfuse on Railway (web, worker, Postgres, ClickHouse, Redis, object storage), one platform Postgres, one worker host. Roughly $20–40/month at sprint scale, dominated by Langfuse's ClickHouse.

---

## 14. State, coordination, and data model

### 14.1 Coordination framework

**TypeScript with LangGraph.js and the Postgres checkpointer (`@langchain/langgraph-checkpoint-postgres`).** Each campaign is a graph run; nodes are the agent steps; edges carry the typed messages. Human gates are LangGraph interrupts, which persist the state and resume on approval. Every node emits Langfuse spans through the Langfuse TypeScript SDK.

Rationale: one language across the Co-Pilot and the platform, so contracts, fixtures, and the Anthropic SDK usage are shared idioms; built-in checkpointing and human-in-the-loop; explicit typed state. The Python-only security libraries (Garak, PyRIT) are used as data sources, not dependencies: their probe taxonomies and selected payloads are ported into JSON seed files under `./evals/seeds/`. See Section 17.1 for the alternatives.

Supporting choices: `@anthropic-ai/sdk` with structured outputs for the Judge and Documentation agents; the dashboard on TanStack Start, Router, Query, Table, and Form; contracts authored as JSON Schema and validated with Ajv on both sides of every boundary, with TypeScript types generated from the schemas so the code cannot drift from `/contracts`; `pg-boss` for the Postgres-backed queue; `node-pg-migrate` for migrations; Vitest for unit, contract, and detector-fixture tests.

### 14.2 Queue

`pg-boss` on the same Postgres instance (it uses `FOR UPDATE SKIP LOCKED` under the hood). One queue for campaign work items, one for regression runs, with regression having priority.

Queue depth is a first-class metric. When depth exceeds a threshold, the Orchestrator stops issuing new campaign plans (`QueueBackpressure`) but regression runs continue. Sustained backpressure pages the operator.

### 14.3 Data model

| Table | Key columns | Purpose |
|-------|-------------|---------|
| `targets` | id, base_url, allowlisted_by, approved_at | Allowlist. |
| `target_versions` | id, target_id, version, first_seen | Version history. |
| `campaigns` | id, plan (jsonb), budget, spend, status, started_at | Orchestrator output. |
| `attempts` | id, campaign_id, parent_attempt_id, fingerprint, category, subcategory, owasp_ids[], technique_tags[], transcript (jsonb), target_version_id, tokens, cost | Every attack attempt. |
| `verdicts` | id, attempt_id, outcome, confidence, stage, rubric_version, judge_model, evidence (jsonb), needs_review | Judge output. |
| `exploits` | id (e.g. AF-2026-0001), fingerprint UNIQUE, severity, category, subcategory, owasp_ids[], status, min_repro (jsonb), family_ids[], discovered_version_id, fixed_version_id | Confirmed, deduplicated exploits. |
| `reports` | id, exploit_id, version, body (jsonb, `VulnReport v1`), status, approved_by, published_at | Report history per exploit. |
| `regression_runs` / `regression_results` | run_id, target_version_id, exploit_id, outcome, replay_count, majority | Harness output. |
| `coverage_snapshots` | target_version_id, category, subcategory, attempts, confirmed, last_run_at | Materialized nightly for the Orchestrator. |
| `nightly_runs` | id, scheduled_for, started_at, finished_at, trigger (`cron`, `run_now`), plan (jsonb), summary (jsonb), spend, status | One row per run; the dashboard's run history. |
| `operator_requests` | id, kind (`rerun`, `focus`, `skip`, `note`), exploit_id (nullable), category (nullable), requested_by, requested_for, source (`ui`, `chat`), status (`queued`, `ran`, `cut`, `cancelled`), nightly_run_id | The queue behind the ticket tracker's rerun button and the chat's write tools. |
| `chat_messages` | id, thread_id, role, content, tool_calls (jsonb), directive_id (nullable), created_at | Chat history with the Orchestrator; every write links to its directive. |
| `agent_events` | id, trace_id, agent, event_type, payload (jsonb), cost, created_at | Audit log; what each agent did and in what order. |
| `ground_truth` | id, transcript, label, labeled_by, labeled_at, category | Judge calibration set. |

### 14.4 Access control (database roles)

| Role | Read | Write |
|------|------|-------|
| `orchestrator` | everything | `campaigns`, `nightly_runs`, `operator_requests.status`, `chat_messages` (assistant turns), `agent_events` |
| `redteam` | own campaign plan, own verdicts | `attempts`, `agent_events` |
| `judge` | `attempts`, `ground_truth` | `verdicts`, `agent_events` |
| `documentation` | `verdicts`, `attempts`, `exploits`, `reports` | `exploits` (upsert by fingerprint), `reports` (draft only) |
| `harness` | `exploits`, `attempts` | `regression_*`, `agent_events` |
| `operator` | everything | `targets`, `exploits.status` and assignee, `reports.status`, `operator_requests`, `chat_messages`, `ground_truth`, config |

### 14.5 Indexes and SLOs

Indexes on `exploits(severity, status)`, `exploits(category, subcategory)`, `attempts(target_version_id, category)`, `verdicts(attempt_id)`, `attempts(fingerprint)`, `agent_events(trace_id, created_at)`. The regression scan (select all open and fixed exploits with families for a version) should plan as an index scan. A CI `EXPLAIN` check is a stretch item (Section 2.2); for the sprint we verify it by hand once.

### 14.6 Migrations

`node-pg-migrate` migrations. Adding a field to `VulnReport` is a schema version bump on the contract plus a data migration that backfills the new field with an explicit `null` or derived value; existing report bodies are never rewritten in place, a new `reports.version` row is added.

---

## 15. Observability layer

The observability layer answers the PRD's six questions and is the Orchestrator's input, so it is designed as data first and dashboards second.

| Question | Source |
|----------|--------|
| Which categories tested, how many cases each? | `coverage_snapshots` |
| Pass/fail rate across categories and versions? | `verdicts` joined to `attempts` and `target_versions` |
| Is the target more or less resilient over time? | Regression pass rate and confirmed-exploit rate per version, trended |
| Which vulnerabilities are open, in progress, resolved? | `exploits.status` |
| What did this run cost, and how is cost scaling? | `attempts.cost`, `agent_events.cost`, Langfuse usage per agent |
| What is each agent doing, in what order? | `agent_events` by `trace_id`; Langfuse trace tree |

**Tracing:** self-hosted Langfuse v3, as in Phases 1–2. It is deployed on Railway (the Langfuse template provides web, worker, Postgres, ClickHouse, Redis, and object storage) rather than on the platform machine, because the Co-Pilot on Railway must be able to reach it to send traces and a laptop-hosted instance would not be reachable. Setting it up is Monday's first infrastructure task; if it slips past Tuesday morning, Langfuse Cloud's free tier is the temporary fallback, since the SDK configuration is only a URL and key. The Co-Pilot and the platform share one Langfuse project, with separate Anthropic keys per role, so target spend appears alongside platform spend and a finding can be traced from the attacker's prompt through the Co-Pilot's own model calls. Every campaign is a trace; every agent step is a span with model, tokens, cost, and the message IDs it consumed and produced. Cost is attributed per agent, not just per platform.

### 15.1 Operator Dashboard

A web app for the security engineer, built on the same queries the Orchestrator reads so the human and the agent see the same numbers. It is the product surface of the platform; Langfuse stays the debugging surface.

| Panel | What it shows | Actions |
|-------|---------------|---------|
| **Findings (ticket tracker)** | One ticket per confirmed exploit: ID, severity, category and OWASP mapping, status, assignee, discovered and last-verified target version, confidence, family size, history. Ticket detail shows the minimal repro, transcript, detector evidence, the report, and the regression results over time. | Change status (`open` → `in_progress` → `fixed` → `verified`, or `false_positive`, `accepted_risk`, `regressed`); assign; add a note; **Re-check tonight** (enqueues a `RerunRequest`); approve or reject publication for high and critical. |
| **Tonight's queue** | Everything queued for the next run with estimated cost, in the order the Orchestrator will take it, plus what will be cut if the envelope is exceeded. | Remove or reorder operator requests; adjust tonight's focus category; Run now (gated, Section 10). |
| **Run history** | One row per nightly run: attempts, verdict split, new tickets, regressions, spend, duration, and a link to the morning report. | Open the report; open the Langfuse trace. |
| **Coverage** | Category × subcategory heatmap for the current target version: attempts, confirmed, last tested. | Click a cell to queue a campaign on it for tonight. |
| **Resilience trend** | Confirmed-exploit rate and regression pass rate per target version over time. | None; this is the "are we getting better" chart. |
| **Cost** | Spend per run, per agent role, and the target's own share; projected monthly spend at the current cadence. | None. |
| **Judge health** | Agreement with ground truth per category, clean-control false positive rate, `needs_review` backlog. | Resolve `needs_review` verdicts (feeds ground truth). |
| **Agent activity** | Live feed during a run: which agent did what, in order, from `agent_events`. | None. |
| **Orchestrator chat** | Chat box docked on every page (Section 4.5). | Ask questions; issue rerun, focus, skip, and note directives with confirmation. |

**Implementation.** A React app built on the TanStack stack (`apps/dashboard`): TanStack Start for the app framework and server functions (which query the platform Postgres through the shared `@agentforge/db` package), TanStack Router for file-based routes, TanStack Query for data fetching and cache invalidation after actions, TanStack Table for the ticket, queue, and run tables, and TanStack Form for status changes, rerun requests, and the chat input. Function components and hooks only; Testing Library for component tests. Single shared operator login for the sprint (environment-variable credentials behind a session cookie), with the database roles in Section 14.4 limiting what the app's connection can write. Tickets are the `exploits` table with a status workflow, not a separate system, so the Documentation Agent, the Regression Harness, and the operator all update the same record.

---

## 16. Security of the platform itself

- **Scope control.** The Target Adapter allowlist is the single choke point; the Red Team Agent has no general HTTP client. Adding a target needs two humans (G1).
- **Credential isolation.** Each agent role has its own Anthropic API key with its own spend visibility. The Red Team process holds only its own key and a campaign-scoped adapter token; it never sees the Judge's or Documentation's keys, the OpenEMR credentials, or the database write roles beyond `attempts`.
- **Access to findings.** Reports and transcripts contain working exploits against a clinical system. Operator UI requires authentication; the DB roles above limit blast radius; exports are logged.
- **Harmful generated content.** Stored, never auto-rendered, flagged by a lightweight classifier so the operator sees a warning before viewing.
- **Audit.** `agent_events` is append-only. An overnight run can be reconstructed step by step from `trace_id`. Chat directives carry `source = chat` and the user who confirmed them.
- **Chat as an attack surface.** The chat reads ticket bodies that contain live attack strings. Retrieved records are passed to the model as quoted data, write tools accept only contract-validated arguments, and no tool can reach the gates in Section 10, so an injected instruction inside a finding cannot escalate.
- **Platform's own scan.** The ATO evidence packet includes a dependency scan (`npm audit` plus a lockfile review) and a ZAP baseline scan against the operator UI.

---

## 17. Alternatives considered and trade-offs

This section is the source for the slide deck. Each decision lists the option chosen, the alternatives, and the reason.

### 17.1 Language and coordination framework

| Option | Pros | Cons | Verdict |
|--------|------|------|---------|
| **LangGraph.js (TypeScript) + Postgres checkpointer** | One language with the Co-Pilot; native checkpointing and human-in-the-loop interrupts; explicit typed state; Langfuse TypeScript SDK. | Smaller community than the Python version; Python-only security libraries become data sources rather than dependencies. | **Chosen** |
| Custom TypeScript state machine + `pg-boss` | Zero framework lock-in; total control; easy to explain in a design review. | We would rebuild checkpointing, retries, and interrupts under time pressure; more code to test in one week. | Strong second. Revisit if LangGraph.js fights us by Tuesday. |
| LangGraph (Python) | Most mature version; direct use of Garak and PyRIT. | Second language and toolchain; contracts and fixtures cannot be shared with the Co-Pilot; the earlier reason for Python (local models) no longer applies since nothing runs locally. | Rejected after confirming the stack |
| CrewAI | Fast to stand up role-based agents. | Opaque orchestration, weak control over hand-offs and state; hard to enforce contracts and trust levels. | Rejected |
| AutoGen | Good multi-agent conversation patterns. | Conversation-centric rather than workflow-centric; contracts and budgets are awkward. | Rejected |
| Anthropic Managed Agents | Hosted loop and sandbox; no infra. | Per-session container cost on a budget that is already tight; less control over the audit trail and the message contracts; the deterministic components would still need hosting. | Rejected for the sprint; could host the Documentation Agent later. |

### 17.2 Red Team model

| Option | Pros | Cons | Verdict |
|--------|------|------|---------|
| **Claude (Haiku 4.5 variants, Sonnet 5.5 strategy) with refusal detection, on top of deterministic mutation** | No new account or budget line; same SDK and bill; high generation quality when it does not refuse. | Safety classifiers decline some techniques, leaving gaps we must measure; shares a vendor with the Judge, which weakens independence and forces the detectors to carry that argument. | **Chosen as the baseline (Mon–Wed) and permanent fallback** |
| **Hosted open-weight model via OpenRouter** | No offensive-security refusals; cheap; different vendor from the Judge; separate rate-limit pool; prompt tuning informed by Wednesday's measured refusal rates. | Needs an account and prepaid credit (available Thursday); open-weight models need re-tuned mutation prompts; Thursday is the busiest day, so it is time-boxed and feature-flagged. | **Added Thursday** for high-refusal categories, if Wednesday's loop is stable |
| Local model via Ollama | Free per token; private. | Ruled out: nothing runs locally, no GPU, `node:22-alpine` images. | Rejected |
| Deterministic mutation only | Free, reproducible, never refuses. | Cannot produce genuinely novel attack strategies; only variants of seeds. | Always-on floor, not sufficient alone |
| Fine-tuned attack model | Best long-term quality. | Out of scope for one week. | Deferred |

### 17.3 Judge design

| Option | Pros | Cons | Verdict |
|--------|------|------|---------|
| **Hybrid: deterministic detectors, then LLM rubric, then tiebreak** | Exact where exactness is possible; semantic where needed; cheapest; auditable. | Two systems to maintain; detector coverage must be kept honest. | **Chosen** |
| LLM-only judge | Simple; handles nuance. | Expensive at volume; drift; cannot be the sole authority on PHI leakage. | Rejected |
| Deterministic-only judge | Perfectly consistent; free. | Misses partial success and scope violations; brittle. | Rejected as sole judge |
| Same model as Red Team | One provider. | Conflict of interest the PRD forbids. | Rejected |

### 17.4 Inter-agent communication

| Option | Pros | Cons | Verdict |
|--------|------|------|---------|
| **Typed JSON messages persisted in Postgres queue and event log** | Replayable; auditable; contracts enforced at the boundary; peer integration through the schema alone. | Polling latency; more rows. | **Chosen** |
| Direct in-process invocation / shared LangGraph state only | Fastest; least code. | No durable audit trail per message; hard to integrate a peer's independently built agent. | Used inside a graph run, but every hand-off is also persisted. |
| Redis / RabbitMQ / SQS | Purpose-built queue; better throughput. | Second piece of infrastructure to deploy and secure in a week. | Deferred until throughput demands it (10K+ tier). |

### 17.5 Observability backend

| Option | Pros | Cons | Verdict |
|--------|------|------|---------|
| **Langfuse self-hosted on Railway** | Data stays in our infrastructure; matches the Phase 1–2 decision and the healthcare context; reachable by both the Co-Pilot and the platform; no vendor limits. | v3 needs web, worker, Postgres, ClickHouse, Redis, and object storage; a few hours of setup on Monday and a small monthly cost. | **Chosen** |
| Langfuse Cloud (free tier) | Zero setup; same SDK, so switching is a URL and key change. | Data leaves our infrastructure; free-tier limits. | Temporary fallback only if self-hosting slips past Tuesday morning |
| LangSmith | Tightest LangGraph integration. | Proprietary; cost at scale; data residency questions for a healthcare context. | Rejected |
| Braintrust | Strong eval tooling. | Eval-centric rather than trace-centric; another vendor. | Rejected |
| Custom only | Total control. | Rebuilding trace UI in a week is wasted effort. | Rejected; custom covers only the coverage dashboard. |

### 17.6 Exploit store

| Option | Pros | Cons | Verdict |
|--------|------|------|---------|
| **Postgres (jsonb for bodies, typed columns for query keys)** | Queryable, indexable, migrations, roles, one system doubles as queue and checkpointer. | Needs a managed instance in deployment. | **Chosen** |
| SQLite | Zero ops. | No roles, weak concurrency, no queue semantics. | Local dev only |
| Document DB | Flexible schemas. | Weaker referential integrity; second system. | Rejected |

### 17.7 Human gate placement

| Option | Pros | Cons | Verdict |
|--------|------|------|---------|
| **Gates on publication of high/critical, target allowlist, new categories, budget increases, remediation** | Humans decide where errors are costly; automation everywhere else. | Approval latency for critical findings overnight. | **Chosen** |
| Approve every report | Zero false positives published. | Defeats the purpose; humans become the bottleneck. | Rejected |
| No gates | Maximum autonomy. | A false critical wastes engineering time; a mis-targeted campaign is a real incident. | Rejected |

### 17.8 Regression pass semantics

| Option | Pros | Cons | Verdict |
|--------|------|------|---------|
| **Minimal repro + stored family + fresh mutations + clean control, majority of R replays** | Detects "behavior changed" false passes and over-blocking. | More target calls per exploit. | **Chosen** |
| Replay exact sequence once | Cheapest. | Passes when phrasing changed; worse than no test, per the PRD. | Rejected |

---

### 17.9 Execution cadence

| Option | Pros | Cons | Verdict |
|--------|------|------|---------|
| **Nightly run + operator queue + Run now** | Predictable daily spend; a morning report to triage; no contention with daytime Co-Pilot traffic on the shared rate limit; matches how a security team actually works. | Up to a day of latency between a deploy and its regression run unless someone presses Run now. | **Chosen** |
| Continuous loop | Fastest feedback on deploys; closest to the PRD's wording. | Spend is bounded only by envelopes, not by time; competes with production traffic; no natural triage rhythm. | Rejected for this team size and budget |
| Deploy-triggered only | Zero idle cost. | No coverage-driven discovery between deploys; the attack surface goes stale. | Folded in: deploys queue regressions for tonight |

### 17.10 Findings tracker

| Option | Pros | Cons | Verdict |
|--------|------|------|---------|
| **Tickets in the platform's own DB, rendered by the dashboard** | The Documentation Agent, Regression Harness, and operator share one record; rerun and status changes drive the queue directly; no sync. | We build the UI. | **Chosen** |
| GitHub Issues or Linear as the tracker | Familiar UI; free. | Two-way sync of status and evidence is its own project; attack transcripts in a third-party tracker; rerun button would be a webhook hack. | Rejected; export to Issues is a possible later feature |
| Langfuse only | Already deployed. | Traces are not tickets; no status workflow, no rerun, no approvals. | Debugging surface only |

### 17.11 Chat with the Orchestrator

| Option | Pros | Cons | Verdict |
|--------|------|------|---------|
| **Chat box with a small, contract-validated tool set and confirm-before-enqueue** | Natural way to ask "why" and to queue work; every action still typed and logged. | Another LLM surface to secure; can mislead if it hallucinates state, hence read tools over real queries only. | **Chosen** |
| Forms and buttons only | Simplest; nothing to secure. | Cannot answer "why did you choose X"; the PRD wants the Orchestrator's reasoning visible. | Kept alongside chat for every action |
| Chat with unrestricted actions | Most convenient. | Chat becomes a bypass for every human gate. | Rejected |

### 17.12 Dashboard framework

| Option | Pros | Cons | Verdict |
|--------|------|------|---------|
| **TanStack Start + Router + Query + Table + Form** | One coherent React stack; type-safe file-based routing; server functions hit the shared DB package without a separate API layer; Table and Form cover the ticket tracker and queue without extra libraries; Vite tooling shared with the rest of the monorepo. | Start is newer than Next.js; fewer copy-paste examples. | **Chosen** (user preference, and the fit is good) |
| Next.js | Largest ecosystem. | A second framework idiom; App Router server components add complexity we do not need for an internal tool. | Rejected |
| Vite SPA + separate Fastify API | Simplest mental model. | Two deployables and a hand-written API surface that server functions give us for free. | Rejected |

## 18. Build-versus-configure decision record

| Tool | What it covers | Where it falls short here | Decision |
|------|----------------|---------------------------|----------|
| Garak | Large probe library for LLM vulnerabilities, detectors, reporting. | Single-shot probes against a model endpoint, not a stateful multi-turn app with tools and uploads; no orchestration, mutation loop, or regression DB. | Port its probe taxonomy and selected payloads into JSON seed files; do not adopt as a dependency (Python). |
| PyRIT | Attack converters (mutation), orchestrators, scoring; designed for red-teaming. | Scorers are generic; no coverage-driven orchestrator; no exploit lifecycle or report schema. | Re-implement the useful converters as TypeScript mutation operators, crediting the source; PyRIT itself is Python and is not a dependency. |
| promptfoo | TypeScript red-team eval runner with OWASP mapping and provider adapters. | Config-driven and largely static; weak multi-turn state; no judge calibration, exploit lifecycle, or coverage-driven orchestrator. | Closest existing TypeScript tool. Its eval file format is the starting point for `./evals/`; not adopted as the runner because the learning loop and regression semantics are the project. |
| OWASP ZAP | HTTP-layer scanning (auth, injection, SSRF, headers). | Knows nothing about LLM behavior. | Configure baseline scan; import findings into the exploit DB. |
| Burp Suite | Same as ZAP, more manual. | Manual; licensing. | Not adopted for automation. |
| Semgrep | Static analysis of the target's code. | Only if we have the Co-Pilot source; does not exercise runtime behavior. | Run if source is available; import findings. |
| Commercial LLM red-team platforms | Turnkey. | Cost, opacity, no custom judge or regression semantics, and the goal is to build the platform. | Not adopted |

Justification for custom agents: no existing tool combines coverage-driven orchestration, a multi-turn stateful attacker with a mutation loop, an independent calibrated judge, and a regression harness with family-based pass semantics. The custom work is exactly that combination; everything else is configured or reused.

---

## 19. Known failure modes and mitigations

| Failure mode | Detection | Mitigation |
|--------------|-----------|------------|
| Red Team generates harmful content | Output classifier on generation | Stored with restricted access; never auto-rendered; not sent to target if it matches a blocked technique list. |
| Judge agrees with everything | Clean-control success rate; verdict distribution shift | Alert; rubric revision; re-judge. |
| Orchestrator has no clear priority | `NoFindingsInWindow` | Bounded exploratory campaign on stalest category. |
| Cascading failure in a run | Typed errors and LangGraph checkpoint | Each node is retried independently; the campaign resumes from the last checkpoint; the operator sees the error chain in the trace. |
| Target changes mid-campaign | Version header on every call | Pause, queue regression, resume with note. |
| Nightly run fails midway | `nightly_runs.status` and LangGraph checkpoint | Resume from checkpoint if within the window; otherwise the morning report lists what did not run and re-queues it for tonight. |
| Chat directive misread | Echo-and-confirm before enqueue | Nothing is enqueued until the user confirms the echoed directive; the directive is shown in tonight's queue where it can be removed. |
| Provider rate limits | 429 handling in adapters | Backoff, Batch API, model failover. |
| Duplicate findings | Fingerprint uniqueness | Upsert into existing exploit, history appended. |
| Judge model deprecation or change | `judge_model` recorded on every verdict | Re-calibrate on ground truth before switching; keep old verdicts attributed. |
| Platform regresses (its own logic) | Detector fixtures, contract tests, Judge invariants, regression SLO check in CI | CI blocks merges. |
| Low-quality signal (many partials, few confirms) | Signal-per-dollar and confirmation rate per category | Orchestrator halts and redirects; operator review. |

---

## 20. Delivery plan against the checkpoints

| When | Deliverable | Scope |
|------|-------------|-------|
| Monday | Target running locally and deployed; self-hosted Langfuse on Railway; Co-Pilot instrumented and given its own Anthropic API key; per-role keys for the platform; `THREAT_MODEL.md`; Target Adapter with Co-Pilot and OpenEMR clients, allowlist, transcript capture; **model router with a provider interface** (Anthropic now, OpenAI-compatible client stubbed for Thursday); contracts v1 for `AttackTranscript`, `Verdict`, `VulnReport`, `RerunRequest`; Postgres schema and migrations including `exploits` status workflow, `nightly_runs`, `operator_requests`; pg-boss with the nightly cron job and Run now. | Stages 1–2, foundation |
| Tuesday (early submission) | Seed eval suite across at least three categories in `./evals/`, OWASP-mapped; Detectors; Judge stages 1–2 running live against the deployed target via Run now; Langfuse wired; **Dashboard v1, read-only**: findings list, run history, coverage table, cost panel (enough for the demo video); `KEY_METRICS.md`; `USERS.md`; `ARCHITECTURE.md`; demo video. | Stages 3–4 hard gates |
| Wednesday | Red Team Agent with deterministic mutation, Haiku variants, Sonnet strategy, and refusal-rate metric; Orchestrator nightly planner (queue order, scoring, envelopes, `NightlyPlan`); **Dashboard v2**: ticket status workflow, assignee, Re-check tonight button, tonight's queue with reorder and remove, morning report. Design review. **First real nightly run Wednesday night.** | Core loop |
| Thursday | Documentation Agent with schema validation and dedupe; Regression Harness with family semantics wired to the rerun queue; ground-truth set and Judge health panel; **Dashboard v3**: approvals queue, resilience trend, agent activity feed, `needs_review` resolution; **Orchestrator chat** with the four write tools and confirm-before-enqueue; **OpenRouter tier**, time-boxed to two hours behind a feature flag, only if Wednesday night's run was stable. **Second nightly run Thursday night**, including operator-queued reruns. | Closing the loop |
| Friday noon (final) | Three or more vulnerability reports, produced from Wednesday and Thursday night runs; every eval case mapped to OWASP categories; AI cost analysis with measured spend and refusal rates with and without OpenRouter; production deployment of worker and dashboard; demo video showing a ticket, a queued re-check, the morning report, and the chat; social post. | Final hard gates |
| Stretch, only if the loop is stable by Thursday night | Triage exercise; ATO evidence packet assembled from existing artifacts; 100-case load test and baseline profile; CI `EXPLAIN` check. | Optional (Section 2.2) |

---

## 21. Open questions

None. All decisions are recorded in Section 2.4 (F1–F9, D1–D3).

Resolved in v0.2: language (TypeScript), target API shape (REST/JSON, uploads via OpenEMR, tool logs only from the Co-Pilot service), identity (role-based test users available), test data (synthetic, seedable), budget (shared Anthropic bill, minimize cost), deployment (Railway, hosted models only, no GPU), deck format (short HTML artifact focused on decisions).

Resolved in v0.3: Co-Pilot service URL (`https://copilot-evidence-production.up.railway.app/`), Claude attacker baseline, self-hosted Langfuse (as in Phases 1–2).

Resolved in v0.4: nightly cadence with an operator queue and Run now; Operator Dashboard with ticket tracker and Orchestrator chat; OpenRouter tier scheduled for Thursday with a go-or-no-go condition.

Settings to confirm before Wednesday night (defaults in parentheses): the nightly run window (01:00 CT, three-hour cap), the nightly budget envelope in dollars, whether Run now is available to every operator or only an admin (every operator, with the cost confirmation), and the dashboard login (one shared operator account for the sprint).

Items to verify during implementation rather than decide now: the exact Co-Pilot REST routes and session model (F2), whether the Co-Pilot's tool-call log is in the response body or a separate endpoint (F4), and the per-technique refusal rate of the Claude attacker tiers, which determines how much coverage the deterministic tier has to carry.
