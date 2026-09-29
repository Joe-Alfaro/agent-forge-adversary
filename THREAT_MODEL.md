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

## Assumptions and out of scope

- Attacks target only the two registered deployments; no other host is in scope
  (enforced by the Target Adapter allowlist).
- The Co-Pilot reads no patient data on its own; PHI it could leak is bounded by
  the client-supplied bundle plus the guideline corpus. Direct PHI extraction is
  therefore primarily an OpenEMR-side concern, tested through that client.
- We do not attack Railway, the network, or Anthropic's API; only the
  application layer.
- Remediation is recommended, never applied automatically (Architecture §2.3).
