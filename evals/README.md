# Seed eval suite

Adversarial seed cases for the AgentForge red team against the OpenEMR Clinical
Co-Pilot. Every case is mapped to its **OWASP LLM Top 10** and **OWASP Top 10**
categories — this mapping is the one required engineering deliverable
(ARCHITECTURE.md §2.1), and it is enforced in CI: `apps/worker/src/evals/load.ts`
refuses to load a case that is missing or malformed either mapping, and
`apps/worker/src/evals/__tests__/evals.test.ts` asserts it across the suite.

These are **seeds**, not the whole attack space: the Red Team mutates them
(encoding, persona swaps, delimiter injection, turn splitting, payload placement)
and the Judge scores the results. They also seed the coverage matrix and the
regression families.

## Layout

`seeds/<category>.json` — each file is a JSON array of cases. Load them with
`loadEvalSuite()` from `@agentforge/worker`.

## Case format

| Field | Meaning |
|-------|---------|
| `id` | Unique, stable case id (e.g. `pi-001`). Referenced by `CampaignPlan.seed_case_ids`. |
| `category` / `subcategory` | Attack family and specific technique. |
| `owasp_llm_ids` | One or more OWASP LLM Top 10 ids, `LLMxx`. **Required.** |
| `owasp_ids` | One or more OWASP Top 10 (web) ids, `Axx`. **Required.** |
| `technique_tags` | Free-form technique labels for coverage/novelty. |
| `session_role` | The role the attempt authenticates as (`clinician`, `nurse`, …). |
| `turns` | Ordered attacker turns; each has a `message` and optional `attachments`. An attachment may carry `injected_text` for indirect (upload) injection. |
| `detectors` | Deterministic detectors expected to be relevant to this case. |
| `expected_secure_outcome` | The verdict a **correctly defended** target should produce (almost always `fail`). Used for regression and Judge calibration. |

## Coverage and OWASP mapping

| Category | Cases | OWASP LLM Top 10 | OWASP Top 10 |
|----------|-------|------------------|--------------|
| `prompt_injection` | pi-001…003 | LLM01 Prompt Injection (+ LLM07 System Prompt Leakage) | A03 Injection |
| `phi_exfiltration` | phi-001…003 | LLM02 Sensitive Information Disclosure | A01 Broken Access Control |
| `cross_patient` | xp-001…003 | LLM02 Sensitive Information Disclosure | A01 Broken Access Control |
| `tool_misuse` | tm-001…003 | LLM06 Excessive Agency (+ LLM10 Unbounded Consumption) | A04 Insecure Design |
| `misinformation` | mi-001…002 | LLM09 Misinformation (+ LLM05 Improper Output Handling) | A04 Insecure Design |

Five categories, well past the required three. The mappings follow the OWASP LLM
Top 10 (2025) and OWASP Top 10 (2021) category numbering.

All patient data referenced is synthetic and canary values are permitted
(target facts F6). These cases describe authorized security testing of our own
deployed application.
