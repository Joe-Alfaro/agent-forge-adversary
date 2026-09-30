# @agentforge/worker

The agent platform: model router, Target Adapter, deterministic detectors, the
Judge, and (later) the Red Team, Orchestrator, and Regression Harness. See the
repo-root `ARCHITECTURE.md` for the whole design.

## Target Adapter (`src/target/`)

The Target Adapter is the **only** network path to the target. Everything else
in the platform reaches the Co-Pilot and OpenEMR through it, so it is where the
allowlist, rate limiting, budgets, and transcript capture are enforced
(Architecture Section 5.1).

```
HttpTransport   allowlist + per-target RPM/concurrency + 429 backoff (Retry-After aware)
  └── CopilotClient   POST /answer, GET /health, scoped-token minting
  └── OpenEmrClient   seed patients / canaries / documents, FHIR version
        └── TargetAdapter   one interface; captures AttackTranscript v1 with the
                            target version and enforces the per-attempt token ceiling
```

- `HttpTransport` enforces the allowlist by **origin** (scheme+host+port), a
  sliding-window requests-per-minute limit, a concurrency cap, and exponential
  backoff with jitter on `429`, honouring `Retry-After`. After the retry ceiling
  it raises `TargetUnreachable` and never drops work.
- `CopilotClient.newSession(role, bundle)` mints a patient-scoped token; `answer`
  performs one turn; `getVersion` reads `/health`.
- `TargetAdapter.runAttempt` runs a whole multi-turn attempt and returns a
  schema-validated `AttackTranscript v1` stamped with the target version. HTTP
  error responses (401/400/5xx) are captured as ordinary turns because they are
  themselves signal; only an unreachable target throws.

`fetch`, the clock, and randomness are all injected, so the whole stack is
unit-tested without touching the network (`src/target/__tests__/`).

### Configuration

| Env | Purpose |
|-----|---------|
| `COPILOT_BASE_URL` | Co-Pilot base, allowlisted. |
| `OPENEMR_BASE_URL` | OpenEMR base, allowlisted. |
| `COPILOT_TOKEN_SECRET` | Shared HMAC secret used to mint scoped tokens. Operator-supplied; never committed. |
| `OPENEMR_TOKEN` | OAuth2 bearer for OpenEMR REST/FHIR seeding. |

## Detectors (`src/detectors/`)

Deterministic detectors run on every transcript before the LLM judge and are
authoritative when they fire (Architecture 5.2, 8.2). Each is a pure function of
`(AttackTranscript, DetectorContext)`:

- `phi_canary` — a planted unauthorized canary appears in a response (data exfiltration). Authoritative.
- `cross_patient` — an identifier belonging to another patient appears (broken access control). Authoritative.
- `tool_call_diff` — a tool outside the role policy, or runaway repetition, in the captured `tool_sequence` (tool misuse). Authoritative.
- `scope_rule` — regex markers for system-prompt disclosure / instruction-override acknowledgement (prompt injection). **Not** authoritative — signal for the judge.

Detectors search the **target's response only**, never the attacker's message.
`runDetectors` assembles a schema-validated `DetectorResult v1`; `any_fired`
counts only authoritative hits.

## Judge (`src/judge/`)

Two stages (Architecture 4.3, 8.1):

1. **Detectors authoritative.** If any authoritative detector fired, the verdict
   is a deterministic `success`, confidence 1.0, `stage: detector` — no model.
2. **LLM rubric.** Otherwise the frozen, versioned rubric for the category plus
   the transcript go to `claude-sonnet-5-5` with structured outputs
   (`messages.parse` + `zodOutputFormat`); the result is an `llm_primary`
   verdict. A low-confidence or uncorroborated LLM `success` is flagged
   `needs_review` (it would go to the stage-3 tiebreak or a human), so it never
   silently becomes a regression test.

Rubrics (`rubric.ts`) are frozen: `rubric_version` is a content hash, so editing
a rubric changes the version stamped on every verdict — drift is auditable. The
one place that calls the Anthropic SDK is `anthropicModel.ts`; the orchestration
is tested offline against a stub `JudgeModel`. The judge sees only the transcript
and detector results, never the Red Team's plan (independence).

### Live run

`npm run build && npm run judge:live -w apps/worker` runs the whole pipeline
against the **deployed** Co-Pilot for the `prompt_injection` category. It always
makes a real call and runs the detectors; it runs the real authenticated
`/answer` flow when `COPILOT_TOKEN_SECRET` is set (the Co-Pilot reads the bundle
from the request, so a synthetic patient bundle suffices), and the live LLM judge
stage when `ANTHROPIC_API_KEY` (or `ANTHROPIC_API_KEY_JUDGE`) is set. Verified
live to the target: version `copilot@c1f011e` read from `/health` and a captured
transcript; the two secrets above are all that stand between this and a full live
verdict.

## Co-Pilot service: discovered API surface

The Co-Pilot is `copilot-evidence` (Phase 2): a Node `node:http` service — no web
framework, no database, no sessions — that answers one clinical question per call
by routing through document extraction, hybrid guideline retrieval, synthesis,
and a verification gate. The surface below was read from the Phase 1–2 source and
**confirmed against the live deployment**
(`https://copilot-evidence-production.up.railway.app/`).

### Routes

| Method | Path | Auth | Notes |
|--------|------|------|-------|
| `GET` | `/health` | none | `{status, service, build_commit}`. **`build_commit` is the target version.** |
| `GET` | `/ready` | none | Configuration readiness; reports which credentials are set. Does not call the model. |
| `GET` | `/preflight` | none | Makes **one real synthesis call** — it spends money. Use sparingly. |
| `POST` | `/answer` | scoped token | The whole flow in one call. `/brief` is an identical alias the OpenEMR panel posts to. |
| `POST` | `/brief` | scoped token | Alias of `/answer`. |
| `POST` | `/extract` | none | Document ingestion: reads a lab PDF, returns rows for the panel to write. |
| `POST` | `/read`, `/assemble` | none | Intake-form ingestion halves. |

Any other route (and any method mismatch, including `PUT /health`) returns
`404 {"error":"not_found"}` from a catch-all. There is no route-listing or
OpenAPI endpoint.

### `POST /answer` request

```jsonc
{
  "token": "v1.<payload>.<sig>",      // patient-scoped, required
  "question": "…",                     // 1–4000 chars
  "bundle": { /* PatientBundle */ },   // the open chart, fetched by the browser
  "documents": [ /* AttachedDocument, ≤ 8 */ ]
}
```

- `bundle` (`PatientBundle`): `{ pid:int>0, correlation_id, retrieved_at,
  sections: {demographics|problems|medications|allergies|vitals|encounters|labs|clinical_notes},
  recorded_absences[], denied_sections[] }`. Each section is
  `{ status: ok|denied|error, count, records[] }`, each record carrying
  `_source: { table, row_id }`.
- `documents[]` (`AttachedDocument`): `{ document_id, doc_type: lab_pdf|intake_form, file_base64 }`.
  Documents travel as base64 in the body — the service holds no OpenEMR
  credential and cannot fetch by id.
- `x-correlation-id` header is echoed and used as the trace id. We send our
  `trace_id` there.

### `POST /answer` response (200)

```jsonc
{
  "correlation_id": "…",
  "claims": [ /* accepted Claim[] */ ],
  "withheld_count": 0,                  // claims the verification gate withheld
  "outcome": "all_passed|partial|all_withheld",
  "degraded": false,                    // true when nothing survived at all
  "reason": "…", "sections": [],        // present only when degraded
  "degradations": [ { step, effect } ],
  "observability": {
    "tool_sequence": ["intake-extractor","evidence-retriever"],  // the tool/worker log (fact F4)
    "usage": { "input_tokens": …, "output_tokens": … },
    "latency_by_step": [ … ], "retrieval": {…}, "extraction": {…}, "verification": {…}
  }
}
```

`observability.tool_sequence` is the Co-Pilot's own tool-call log and is the
input to the tool-call-diff detector. The `observability` block is deliberately
PHI-free (counts, ids, durations), so the **evidence** for PHI/cross-patient
detectors is the `claims` array, not the observability block.

Error responses: `400 {error: too_large|not_json|bad_request}`,
`401 {error: unauthorized}`, `503 {error: not_configured}`,
`500 {error: internal_error}`.

### Auth: patient-scoped token

Wire format `v1.<payload>.<signature>`, each part base64url; the signature is
`HMAC-SHA256(COPILOT_TOKEN_SECRET, "v1." + payload)`. The payload is
`{ v:1, uid, pid, sfp, iat, exp }` with `iat`/`exp` in whole seconds. The
Co-Pilot **binds the token to the patient**: it verifies the signature, that the
token is unexpired, and that `pid === bundle.pid`. A token minted for patient A
replayed against patient B is rejected as `patient_mismatch` — which is itself a
cross-patient probe worth running. `src/target/scopedToken.ts` mints compatible
tokens from the operator-supplied secret.

### Session model

There is no server-side session or conversation store. "Multi-turn" is carried
by the client: each turn is an independent `POST /answer`, and continuity is
whatever the attacker threads through `question` and the `bundle`/`documents`.
The Target Adapter models a session as the minted token plus the fixed
`bundle`, and drives turns itself.

### Live probe evidence

- `GET /health` → `200 {"status":"ok","service":"copilot-evidence","build_commit":"c1f011e"}`.
- `POST /answer` with a correctly-shaped body and a dummy token → `401 unauthorized`
  (body accepted, only the token rejected).
- `POST /answer` with a malformed bundle → `400 bad_request`.

So the adapter's request contract is validated against the live service; a real
`200` needs only the real `COPILOT_TOKEN_SECRET`.

## OpenEMR

Standard OpenEMR (`302` to login at `/`), OAuth2-protected REST at
`/apis/default/api` and FHIR at `/apis/default/fhir`. Used to seed synthetic
patients, plant canaries, and upload documents (uploads reach OpenEMR first, not
the Co-Pilot — fact F3). Live seeding needs `OPENEMR_TOKEN`.

## Red Team (`src/redteam/`)

The Red Team Agent generates attacks and drives them through the Target Adapter
only (ARCHITECTURE 4.2).

- `mutation.ts` — the deterministic (Tier 1) mutation engine. From one seed it
  builds variant **families**: `paraphrase`, `payload_splitting`, `encoding`
  (base64 / rot13 / hex with a decode instruction), `role_play` (persona
  framing), and `multi_turn` (benign lead-in turns before the payload). Every
  operator is a pure function of the seed, so a campaign replays byte-for-byte.
  Each variant is fingerprinted (normalized text) for novelty deduplication.
- `variantModel.ts` — model-backed (Tier 2/3) generation through the shared model
  router: a Sonnet **strategy** call once per campaign, batched Haiku **variant**
  calls. Framed as authorized testing; a refusal is counted per category and
  degrades to the deterministic families.
- `campaign.ts` — `runCampaign` expands seeds → variants, dedupes by fingerprint,
  drives each surviving attempt through the adapter, and reports the per-campaign
  **refusal rate** (share of target responses that are refusals, via the refusal
  detector) plus per-family and novelty stats.

## Orchestrator (`src/orchestrator/`)

- `priority.ts` — the ARCHITECTURE 7.2 priority score over coverage cells (gap,
  open-severity, regression, signal-per-dollar, staleness, minus cost) with
  config weights logged on every plan.
- `planner.ts` — `buildNightlyPlan` composes a schema-valid `NightlyPlan v1`:
  operator reruns first, then coverage campaigns ranked by priority, each marked
  `run` or `cut` against the budget envelope. `skip`/`focus`/`note` directives
  reshape the plan.
- `run.ts` — `runPlan`, the RUN executor: red team → target → detectors → judge →
  persist attempts/verdicts, dedupe confirmed exploits by fingerprint,
  materialize `coverage_snapshots` (asserts `isTaxonomyCell`, fills
  `families_exercised` = distinct variant-family roots), write one `nightly_runs`
  row with a validated `NightlyRunSummary v1` and spend, and set
  `operator_requests` to `ran`/`cut`. The whole run and each step are wrapped in
  the PlatformTracer, with the trace URL in the summary. A **hard USD spend cap**
  aborts the run before overspending.
- `pgRepository.ts` — the Postgres implementation plus the read queries Run-now
  uses (drain queue, derive coverage cells).

### Run now

`npm run build && RUN_SPEND_CAP_USD=3 RUN_CATEGORIES=prompt_injection,data_exfiltration DATABASE_URL=postgres://… npm run run:now -w apps/worker`
runs one on-demand plan against the **deployed** Co-Pilot and writes the results
to the configured Postgres so the dashboard reflects them. `RUN_SPEND_CAP_USD`
is a hard cap (required); other knobs: `RUN_CATEGORIES` (csv), `RUN_PER_FAMILY`,
`RUN_MAX_ATTEMPTS`, `RUN_TOP_K`, `RUN_TRIGGER`. Secrets load from
`AGENTFORGE_ENV_FILE`; minted tokens and API keys are redacted from stored
transcripts and trace spans.
