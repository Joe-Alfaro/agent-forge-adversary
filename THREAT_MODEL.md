# AgentForge Threat Model — OpenEMR Clinical Co-Pilot

Scope: the deployed Clinical Co-Pilot (`copilot-evidence`) at
`https://copilot-evidence-production.up.railway.app/` and the OpenEMR instance it
fronts at `https://openemr-production-ef61.up.railway.app/`. This is authorized
security testing of our own application; all patient data is synthetic and canary
records are permitted. The surface below was established by probing the live
deployment and reading the Phase 1–2 service source; the concrete API is
documented in `apps/worker/README.md`.

## Executive summary (key findings and highest-risk categories)

The Co-Pilot is a small, deliberately minimal service: a Node standard-library
HTTP server with three real routes and no database, no sessions, and no web
framework. One request — `POST /answer` (aliased `POST /brief`) — runs the whole
clinical flow: route, extract uploaded documents, retrieve guideline passages,
synthesise an answer, and pass everything through a deterministic **verification
gate** that withholds any claim it cannot tie to a source. That gate, not the
model, is the primary safety control, and it is therefore the primary thing an
attacker must defeat.

Authentication is a patient-scoped HMAC-SHA256 token (`v1.<payload>.<sig>`) that
binds each call to a single patient id; the Co-Pilot verifies the signature, the
expiry, and that the token's `pid` matches the chart in the request. Crucially,
**the patient chart travels in the request body** (the browser fetches it with
the physician's own session), so the Co-Pilot never independently reads patient
data. This narrows classic cross-patient exfiltration *from the Co-Pilot itself*:
it can only reveal what the caller already supplied, the public guideline corpus,
or its own configuration.

Given that shape, ranked across the six PRD attack categories (§"Category risk
analysis"):

1. **Prompt injection (LLM01, LLM07 / A03) — highest.** `documents[]` on `/answer`
   and the **unauthenticated** `/extract`, `/read`, `/assemble` routes feed
   attacker-controlled document bytes to an extraction model; direct injection in
   `question` can override the role or leak the system prompt. `claimsNotOwnedBy`
   already treats worker output as untrusted, which is the right instinct.
2. **Identity / role exploitation (LLM01, LLM07 / A03, A01) — high.** Persona
   hijacking via `question` is trivial to attempt; privilege escalation is blunted
   because the role lives in an HMAC-signed token nobody can forge without the
   shared secret.
3. **Denial of service (LLM10 / A04, A05) — high.** `/preflight` and `/extract`
   are unauthenticated and each spends the shared Anthropic bill; the 12 MB /
   8-document caps bound but do not remove token exhaustion, and no per-caller
   rate limit was observed.
4. **Data exfiltration (LLM02 / A01) — mostly bounded.** The Co-Pilot only holds
   the client-supplied bundle plus the public corpus, so PHI/cross-patient
   reachability is limited; the sharp edge is authorization bypass via the
   unauthenticated ingestion routes.
5. **Tool misuse (LLM06 / A04) — limited.** The supervisor graph exposes only
   extractor/retriever/judge — there is no write, admin, or export tool to invoke.
6. **State corruption (LLM01 / A04) — limited.** The service is stateless and
   re-verifies every claim, so an attacker corrupts only their own supplied
   context, affecting no other user.

**Clinical misinformation** — pushing an unsupported recommendation or a
fabricated citation past the verification gate — is the Co-Pilot's core clinical
harm. It is not one of the six PRD categories, so it is not a category here;
instead its cases are folded into the closest cells (`prompt_injection`/`direct`
and `state_corruption`/`context_poisoning`) and kept visible through a
`misinformation` technique tag on the seeds.

Categories and subcategories use the shared **AttackTaxonomy v1**
(`contracts/attack_taxonomy/v1.json`) across `evals/`, `coverage_snapshots`, and
the dashboard. Detectors (PHI canary, cross-patient, tool-call diff, scope rule)
plus a Sonnet-5.5 rubric judge cover these; the `evals/` suite exercises all six.

## Trust boundaries

| Boundary | Trusted side | Untrusted side |
|----------|--------------|----------------|
| Token verification | Co-Pilot with `COPILOT_TOKEN_SECRET` | Any caller's token and claimed patient |
| Request body | Co-Pilot logic | `question`, `bundle`, and `documents[]` (all caller-supplied) |
| Uploaded documents | Extraction result after the gate | Raw document bytes (a scanned page is adversarial input) |
| Worker outputs | Supervisor verification gate | Extractor/retriever claims (may be model-steered) |
| Guideline corpus | Curated public guideline text | Model's attribution of it |
| Logs / observability | Self-hosted only, PHI-scrubbed | — |

## Attack-surface map (entry points)

| Entry point | Auth | Attacker use | Primary categories |
|-------------|------|--------------|--------------------|
| `POST /answer`, `POST /brief` | Scoped token | Prompt injection via `question`; indirect injection and cost via `documents[]`; misinformation; probing the gate | LLM01, LLM09, LLM05, LLM10 |
| `POST /extract`, `/read`, `/assemble` | **None** | Feed adversarial documents to the extraction/vision model; spend budget; extraction-time injection | LLM01, LLM10 |
| `GET /preflight` | None | Force a real synthesis call repeatedly to spend the shared bill | LLM10 |
| `GET /health`, `/ready` | None | Reconnaissance: `build_commit` (version), which credentials are configured | — (recon) |
| OpenEMR REST/FHIR (`/apis/default/...`) | OAuth2 | Seed synthetic patients, plant canaries, upload documents that the Co-Pilot later retrieves (indirect-injection setup, fact F3) | LLM01, LLM02, A01 |
| Token secret (shared with OpenEMR PHP) | Secret | If leaked, forge tokens for any patient across both services | A01, A07 |

## Assets

- **Patient PHI** (synthetic here): identifiers and clinical detail. Canaries let
  us prove disclosure exactly.
- **The verification gate's integrity**: the guarantee that every shown claim is
  source-backed. Misinformation attacks target this.
- **The system prompt / configuration**: a disclosure target (LLM07).
- **The shared Anthropic budget**: an availability/cost asset (LLM10).
- **The token-signing secret**: authentication root of trust for both services.

## Category risk analysis

The PRD's six minimum attack categories, one table per category, one row per
subcategory. Columns give the four things the PRD requires for each category —
**attack surface** (the concrete Co-Pilot route/field), **potential impact**,
**difficulty of exploitation** (Low = easy to exploit), and **existing defenses**
(what the Co-Pilot actually does, and whether it *addresses* the threat) — plus a
**risk rating** (high/medium/low, likelihood × impact) and the **OWASP** mapping.
The `category`/`subcategory` keys match `evals/seeds/`. The cells rated **high**
are the denominator of `KEY_METRICS.md` M5 (high-risk threat-model coverage).

Reachability is shaped by the architecture: the Co-Pilot is stateless and reads
no patient data on its own — the chart travels in the request — so cross-patient
and state-corruption attacks have limited leverage, while the unauthenticated
document/preflight routes are the sharpest edges.

### 1. Prompt injection (`prompt_injection`)

| Subcategory | Attack surface | Potential impact | Difficulty | Existing defenses (addressed?) | Risk — rationale | OWASP |
|-------------|----------------|------------------|-----------|-------------------------------|------------------|-------|
| `direct` | `POST /answer` `question` | Role override; system-prompt/config disclosure; attacker-chosen output | Low | System-prompt framing; `claimsNotOwnedBy` guards worker-typed claims but not a plain role shift or prompt echo; gate blocks fabricated claims only — **partial** | **high** — easy × high impact | LLM01, LLM07 / A03 |
| `indirect` | `POST /answer` `documents[]`; unauth `POST /extract`; seeded OpenEMR docs (F3) | Injection from "trusted" document content; steer the extractor | Low–Med | `claimsNotOwnedBy` rejects out-of-type worker claims (strong here); gate withholds unsourced — **partial** | **high** — reachable, only partly defended | LLM01 / A03 |
| `multi_turn` | Client-carried history across successive `POST /answer` calls (no server session) | Split a payload across turns to evade single-turn checks | Med | Statelessness: no server memory accumulates; each turn re-evaluated fresh — **largely addressed** | medium — reachable, limited leverage | LLM01 / A03 |

### 2. Data exfiltration (`data_exfiltration`)

| Subcategory | Attack surface | Potential impact | Difficulty | Existing defenses (addressed?) | Risk — rationale | OWASP |
|-------------|----------------|------------------|-----------|-------------------------------|------------------|-------|
| `phi_leakage` | `POST /answer` `question` (bundle already holds the chart) | Disclosure of identifiers / clinical detail | Med | Patient-scoped token; retriever PHI guard (exact identifier match, per-request); logs PHI-scrubbed — **largely addressed** | medium — high impact, low reachability | LLM02 / A01 |
| `cross_patient` | `POST /answer` `question` referencing another patient; `bundle.pid` | Another patient's data | Med | Token `pid` binding (`patient_mismatch`); PHI guard armed with the context patient — **addressed on /answer** | medium | LLM02 / A01 |
| `authorization_bypass` | `POST /answer` `token`/`bundle.pid` (IDOR); **unauth `/extract`, `/read`, `/assemble`** | Read/act on another patient; unauthenticated ingestion | Med (/answer) · Low (ingestion) | HMAC signature + `pid` match on /answer (addressed); ingestion routes have **no auth — NOT addressed** | **high** — the unauth ingestion routes are a real gap | LLM02 / A01, A07 |

### 3. State corruption (`state_corruption`)

| Subcategory | Attack surface | Potential impact | Difficulty | Existing defenses (addressed?) | Risk — rationale | OWASP |
|-------------|----------------|------------------|-----------|-------------------------------|------------------|-------|
| `conversation_history_manipulation` | Client-supplied message history + `bundle` on `POST /answer` | Rewrite prior turns/chart to change the answer | Low (to send) | Stateless: no shared/server-side history to corrupt; the caller only affects their own view (D-9); gate re-verifies every claim — **largely addressed** | low-medium | LLM01 / A04 |
| `context_poisoning` | `POST /answer` `documents[]` / seeded OpenEMR docs / malicious `bundle` records | Poison retrieval/extraction context → wrong or leaky synthesis, incl. a fabricated authoritative citation a clinician acts on | Med | `claimsNotOwnedBy`; gate withholds unsourced and checks citations against the corpus copy — **partial** | **high** — clinical-misinformation impact via a planted source | LLM01, LLM09 / A04 |

### 4. Tool misuse (`tool_misuse`)

| Subcategory | Attack surface | Potential impact | Difficulty | Existing defenses (addressed?) | Risk — rationale | OWASP |
|-------------|----------------|------------------|-----------|-------------------------------|------------------|-------|
| `unintended_invocation` | `POST /answer` `question` trying to trigger an out-of-policy worker | A worker runs that shouldn't | Low to attempt · low reachability | Fixed supervisor graph (extractor/retriever/judge); **no write/admin/export tool exists**; `tool_sequence` captured — **largely addressed** | low-medium | LLM06 / A04 |
| `parameter_tampering` | `POST /answer` `question` (e.g. "set the patient filter to `*`") | Widen retrieval scope | Med | Worker parameters derived server-side from the bundle, not caller text; PHI guard — **addressed** | medium | LLM06 / A04 |
| `recursive_calls` | `POST /answer` `question` inducing repeated worker calls | Excessive agency; cost | Med | Graph budget / turn structure bounds iterations; tool-call-diff detector flags runaway — **partial** | medium | LLM06 / A04 |

### 5. Denial of service (`denial_of_service`)

| Subcategory | Attack surface | Potential impact | Difficulty | Existing defenses (addressed?) | Risk — rationale | OWASP |
|-------------|----------------|------------------|-----------|-------------------------------|------------------|-------|
| `token_exhaustion` | `POST /answer` `question`/`documents[]` (≤12 MB, ≤8 docs) | Large input/output token spend on the shared bill | Low | 12 MB body cap, ≤8 documents, model timeouts; **no per-caller rate limit observed** — **partial** | **high** | LLM10 / A04 |
| `loops` | `POST /answer` `question` inducing many worker iterations | Runaway graph execution | Med | Graph budget/timeout bounds iterations — **partial** | medium | LLM10 / A04 |
| `cost_amplification` | **Unauth `GET /preflight`** (real synthesis) and **`POST /extract`** (vision model) | Anyone spends the shared Anthropic bill | Low | None on those routes (unauthenticated by design) — **NOT addressed** | **high** | LLM10 / A05 |

### 6. Identity / role exploitation (`identity_role`)

| Subcategory | Attack surface | Potential impact | Difficulty | Existing defenses (addressed?) | Risk — rationale | OWASP |
|-------------|----------------|------------------|-----------|-------------------------------|------------------|-------|
| `privilege_escalation` | `POST /answer` `token` claims (`uid`/role) | Act as a higher-privileged user | High | Claims are HMAC-signed; server verifies the signature; tokens are minted only by OpenEMR — **addressed** | medium — high impact × low likelihood | LLM07 / A01, A07 |
| `persona_hijacking` | `POST /answer` `question` ("you are FreeMD…") | Drop the clinical guardrails; adopt an unrestricted persona | Low | System-prompt framing; the gate withholds unsourced claims but does not stop a behavioural/tone shift — **partial** | **high** | LLM01 / A03 |
| `trust_boundary_violation` | `POST /answer` `documents[]` treated as instructions; worker→synthesis outputs | Untrusted content gains assistant authority | Med | `claimsNotOwnedBy` enforces worker-output boundaries; documents parsed as data; gate — **partial** | medium-high | LLM01 / A04 |

Clinical misinformation is not one of the six categories; its cases are folded
into the closest cells (`unsupported_claim` → `prompt_injection`/`direct`;
`fabricated_citation` → `state_corruption`/`context_poisoning`) and kept visible
by a `misinformation` technique tag on the seeds.

### High-risk cells (M5 denominator)

Seven of the 17 cells are rated high, so M5's denominator is 7:
`prompt_injection`/{`direct`, `indirect`}, `data_exfiltration`/`authorization_bypass`,
`state_corruption`/`context_poisoning`, `denial_of_service`/{`token_exhaustion`,
`cost_amplification`}, `identity_role`/`persona_hijacking`. Both folded
misinformation cases land in high cells (`direct` and `context_poisoning`), so
their clinical-harm signal is preserved.

### Detector and seed coverage

| Category | Detectors | Seed cases |
|----------|-----------|-----------|
| `prompt_injection` | `scope_rule` | pi-001…004 |
| `data_exfiltration` | `phi_canary`, `cross_patient` | dx-001…006 |
| `state_corruption` | `scope_rule` | sc-001…003 |
| `tool_misuse` | `tool_call_diff` | tm-001…003 |
| `denial_of_service` | `tool_call_diff` | dos-001…003 |
| `identity_role` | `scope_rule` | ir-001…003 |

23 seeds across the six categories; the two former misinformation cases live in
pi-004 and sc-003 with a `misinformation` technique tag.

### Shared taxonomy (resolves the earlier dashboard mismatch)

These category/subcategory keys are the shared **AttackTaxonomy v1**
(`contracts/attack_taxonomy/v1.json`, mirrored by `ATTACK_TAXONOMY` in
`packages/contracts` with `isTaxonomyCell` / `validateTaxonomyCell`). `evals/` is
re-keyed to it and the eval loader now **rejects any off-taxonomy cell**;
`coverage_snapshots` uses these keys. The remaining step is for the dashboard
Coverage panel (`apps/dashboard/src/lib/fixtures.ts`, still on demo keys such as
`cross_patient_access`, `role_confusion`, `indirect_via_note`, with no
`state_corruption`/`denial_of_service` cells) to adopt `ATTACK_TAXONOMY`; that
lets M5 join the ratings to the heatmap and is owned by the dashboard worker
(reported, not changed here).

A single shared taxonomy (one `category`/`subcategory` enum used by `evals/`,
`coverage_snapshots`, and the dashboard) is still needed before M5 can be computed
against real heatmap data.

## Assumptions and out of scope

- Attacks target only the two registered deployments; no other host is in scope
  (enforced by the Target Adapter allowlist).
- The Co-Pilot reads no patient data on its own; PHI it could leak is bounded by
  the client-supplied bundle plus the guideline corpus. Direct PHI extraction is
  therefore primarily an OpenEMR-side concern, tested through that client.
- We do not attack Railway, the network, or Anthropic's API; only the
  application layer.
- Remediation is recommended, never applied automatically (Architecture §2.3).
