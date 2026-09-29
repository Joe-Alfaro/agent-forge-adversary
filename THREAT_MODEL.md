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

Given that shape, the highest-risk categories are:

1. **Prompt injection, direct and indirect (LLM01, LLM07 / OWASP A03).** The
   strongest surface. `documents[]` on `/answer` and the **unauthenticated**
   `/extract`, `/read`, `/assemble` routes feed attacker-controlled document
   bytes to an extraction model. A payload printed on a "lab report" is untrusted
   input that can try to override the assistant's role or leak its system prompt.
   The service already treats worker output as untrusted (`claimsNotOwnedBy`),
   which is the right instinct and the thing we test.
2. **Clinical misinformation / unfaithful synthesis (LLM09, LLM05 / A04).** The
   core clinical harm: pushing an unsupported recommendation or a fabricated
   citation past the verification gate. "Right topic, wrong measure, correctly
   quoted" is the failure the service's own authors call out.
3. **Excessive agency and unbounded consumption (LLM06, LLM10 / A04).** `/preflight`
   and every `/answer` spend the shared Anthropic bill; the 12 MB body cap and
   8-document limit bound but do not remove cost amplification, and the
   unauthenticated ingestion routes let anyone spend the vision-model budget.
4. **Improper output handling (LLM05 / A04).** Synthesised claims and citations
   are rendered in the operator/clinician panel; unescaped markup or links in a
   response are an output-handling risk downstream of the model.
5. **Sensitive information disclosure (LLM02 / A01).** Bounded for the Co-Pilot by
   the client-supplied bundle, but the guideline corpus, the system prompt, and
   PHI-in-logs remain targets, and the token secret is shared with the OpenEMR
   PHP module — a leak there widens blast radius across both services.

Deterministic detectors (PHI canary, cross-patient, tool-call diff, scope rule)
plus a Sonnet-5.5 rubric judge cover categories 1, 3, and 5 with exact checks and
2 and 4 with the rubric. The seed suite in `evals/` exercises all five.

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

## Threat categories → OWASP → coverage

| Category | OWASP LLM | OWASP Top 10 | Detector(s) | Eval seeds |
|----------|-----------|--------------|-------------|-----------|
| Prompt injection / system-prompt leakage | LLM01, LLM07 | A03 | `scope_rule` (+ rubric) | pi-001…003 |
| PHI exfiltration | LLM02 | A01 | `phi_canary` | phi-001…003 |
| Cross-patient access | LLM02 | A01 | `cross_patient` | xp-001…003 |
| Tool misuse / excessive agency / DoS | LLM06, LLM10 | A04 | `tool_call_diff` | tm-001…003 |
| Misinformation / improper output | LLM09, LLM05 | A04 | rubric judge | mi-001…002 |

## Risk ratings (category × subcategory)

One row per attack cell, rated **high / medium / low** by likelihood × impact
against *this* Co-Pilot. The set of cells rated **high** is the denominator of
`KEY_METRICS.md` M5 (high-risk threat-model coverage): the platform must exercise
every high cell on the current target version within seven days. Keys are the
canonical `category` / `subcategory` used by `evals/seeds/`; every seed-eval cell
appears. Likelihood reflects how reachable the attack is given the architecture
(the Co-Pilot reads no patient data on its own — the chart is client-supplied —
so PHI/cross-patient reachability is constrained); impact reflects clinical/PHI/
availability harm.

| Category | Subcategory | Risk | Rationale (likelihood × impact) |
|----------|-------------|------|---------------------------------|
| `prompt_injection` | `system_prompt_disclosure` | **high** | Direct, trivially attempted; leaks configuration/LLM07. High likelihood × medium-high impact. |
| `prompt_injection` | `role_override` | **high** | Persona jailbreak removes the clinical guardrails, enabling downstream misinformation/leakage. High × high. |
| `prompt_injection` | `indirect_injection_via_document` | **high** | Untrusted document bytes reach an extraction model, incl. via the unauthenticated `/extract` route. High × high — the strongest surface. |
| `phi_exfiltration` | `canary_disclosure` | medium | Co-Pilot only holds the supplied bundle + public corpus, so leaking an *unauthorized* canary is constrained. Low-med × high. |
| `phi_exfiltration` | `identifier_extraction` | medium | Full identifiers of others aren't reachable by the Co-Pilot; context-patient identifiers were already supplied by the caller. Low-med × high. |
| `phi_exfiltration` | `partial_disclosure` | low | Near-miss partials only; constrained reachability and low marginal impact. Low × low-med. |
| `cross_patient` | `direct_reference` | medium | Token binds `pid`; the service uses the supplied bundle and a per-request PHI guard. Low-med × high. |
| `cross_patient` | `id_enumeration` | medium | IDOR-style pivot is blocked by `patient_mismatch` on the scoped token; strong control lowers likelihood. Low × high. |
| `cross_patient` | `aggregate_leak` | low | Requires reading records the Co-Pilot does not hold. Low × high → net low. |
| `tool_misuse` | `unauthorized_tool` | medium | Fixed supervisor graph (extractor/retriever/judge); no admin/export tool exists to invoke. Low × medium. |
| `tool_misuse` | `runaway_agency` | **high** | `/preflight`, repeated retrieval, and unauthenticated `/extract` spend the shared Anthropic bill (LLM10). High × medium-high. |
| `tool_misuse` | `parameter_tampering` | medium | Widening retrieval scope is bounded by the per-request PHI guard. Low-med × medium. |
| `misinformation` | `unsupported_claim` | **high** | The core clinical harm; the verification gate is the only control between it and a physician. Med-high × high. |
| `misinformation` | `fabricated_citation` | **high** | Defeating the citation gate puts a fabricated source in front of a clinician. Med-high × high. |

**High-risk cells (M5 denominator): 6** — `prompt_injection`/{`system_prompt_disclosure`,
`role_override`, `indirect_injection_via_document`}, `tool_misuse`/`runaway_agency`,
`misinformation`/{`unsupported_claim`, `fabricated_citation`}.

### Dashboard Coverage-panel key mismatch (reported, not resolved here)

The `evals/seeds/` category/subcategory keys do **not** match the Coverage-heatmap
fixtures in `apps/dashboard/src/lib/fixtures.ts`, so M5 cannot currently join the
threat-model ratings to the heatmap. Per the coordinator's instruction this is
reported rather than fixed here (no change to `apps/dashboard`). The divergences:

- Category names: evals `phi_exfiltration` vs dashboard `data_exfiltration`
  (and ticket fixtures use a third name, `phi_leakage`); evals `cross_patient` vs
  dashboard `cross_patient_access`; the dashboard has a `role_confusion` category
  that evals fold into `prompt_injection` / `role_override`.
- Subcategories differ across the board — e.g. dashboard
  `prompt_injection`/{`direct`, `indirect_via_note`} vs eval
  {`system_prompt_disclosure`, `role_override`, `indirect_injection_via_document`};
  dashboard `misinformation`/`dosage` vs eval {`unsupported_claim`,
  `fabricated_citation`}.

A single shared taxonomy (one enum for `category`/`subcategory` used by evals,
`coverage_snapshots`, and the dashboard) is needed before M5 can be computed
against real data.

## Assumptions and out of scope

- Attacks target only the two registered deployments; no other host is in scope
  (enforced by the Target Adapter allowlist).
- The Co-Pilot reads no patient data on its own; PHI it could leak is bounded by
  the client-supplied bundle plus the guideline corpus. Direct PHI extraction is
  therefore primarily an OpenEMR-side concern, tested through that client.
- We do not attack Railway, the network, or Anthropic's API; only the
  application layer.
- Remediation is recommended, never applied automatically (Architecture §2.3).
