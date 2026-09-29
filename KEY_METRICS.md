# Key metrics

The metrics AgentForge tracks to answer the PRD's questions — coverage, efficacy,
Judge quality, resilience over time, and cost (ARCHITECTURE.md §15). Each has a
definition and a target. **Status** is either *measured* (a value we already have
from the seed suite or the pipeline) or *target* (needs a live nightly campaign,
which is pending the operator's `COPILOT_TOKEN_SECRET` and Anthropic keys). No
live campaign has run yet, so runtime values below are targets.

## Coverage

| Metric | Definition | Target | Status |
|--------|-----------|--------|--------|
| OWASP LLM Top 10 coverage | Distinct OWASP LLM categories with ≥1 seed case | ≥ 5 of 10 | **Measured: 7** (LLM01, LLM02, LLM05, LLM06, LLM07, LLM09, LLM10) |
| OWASP Top 10 coverage | Distinct OWASP web categories with ≥1 seed case | ≥ 3 | **Measured: 3** (A01, A03, A04) |
| Seed cases per category | Authored seed cases per attack category | ≥ 3 core categories | **Measured: 13 cases / 5 categories** |
| Cell coverage | Fraction of category×subcategory cells with ≥ configured attempts for the current target version | ≥ 80% "sufficiently covered" (§7.5) | Target |
| Coverage sufficiency | A cell with ≥ N attempts, ≥ 1 variant family, and no open findings, per version | Per-version, resets on new version | Target |

## Attack efficacy

| Metric | Definition | Target | Status |
|--------|-----------|--------|--------|
| Attack success rate per category | Confirmed `success` verdicts ÷ attempts, by category×version | Trended, not fixed; a drop across versions is the goal | Target |
| Partial rate | `partial` verdicts ÷ attempts | Feeds mutation; watched for "many partials, few confirms" (§19) | Target |
| Novelty rate | Non-duplicate generated sequences ÷ generated (fingerprint check) | Above a floor; below it halts a campaign (§7.3) | Target |

## Detectors and Judge quality

| Metric | Definition | Target | Status |
|--------|-----------|--------|--------|
| Detector-resolved fraction | Attempts decided by an authoritative detector without an LLM judge call | ≥ 40% (§13.1) | Target |
| Detector precision | Authoritative detector fires that a human confirms ÷ all fires | ≥ 0.99 (canary/cross-patient/tool-diff are exact) | Target |
| Judge agreement | Judge outcome = ground-truth label on the labelled set, per category | ≥ 0.90; drop > delta trips a drift alert (§8.3) | Target |
| Clean-control false-positive rate | `success` verdicts on benign clinical controls | **0** — a hard CI invariant (§8.3) | Target (invariant defined) |
| Judge consistency | Same outcome for the same transcript across 3 runs | 100% (CI invariant) | Target (invariant defined) |
| `needs_review` rate | Verdicts flagged for human/tiebreak ÷ verdicts | Low and falling as ground truth grows; every review improves the Judge | Target |
| Ground-truth set size | Hand-labelled transcripts per category | ≥ 30 per category (§8.3) | Target |

## Resilience (regression)

| Metric | Definition | Target | Status |
|--------|-----------|--------|--------|
| Regression pass rate | Exploit families that pass (minimal repro + all stored variants + fresh mutations fail, clean control still works) ÷ tested, per version | Trended up across versions | Target |
| Reappearance rate | Previously-fixed exploits that regress on a new version | → 0 | Target |
| Regression suite duration | Wall-clock for the full suite | < 20 min for 200 exploits at R=3 (§9.6) | Target |

## Cost and attacker health

| Metric | Definition | Target | Status |
|--------|-----------|--------|--------|
| Cost per attack case | End-to-end spend for one case (generation, ≤3 turns, detectors, judge, amortized orchestration/docs) | ~$0.03–0.07 estimated (§13.3); replace with measured dev spend | Target (estimate) |
| Cost per confirmed finding | Campaign spend ÷ confirmed findings | Minimise; reported per run | Target |
| Signal-per-dollar | Confirmed + partial verdicts per dollar, trailing window | Above a floor; two windows below it halts the campaign (§7.3) | Target |
| Refusal rate per technique | Attempts where the attacker model refused (`stop_reason: refusal` or classifier hit) ÷ attempts, by technique | Tracked to decide the Thursday OpenRouter tier (§12) | Target |
| Nightly spend vs envelope | Actual spend ÷ nightly budget envelope | ≤ 1.0; overage cut items shown in the report | Target |

## Measured so far

From the seed suite (no live campaign): **13 seed cases across 5 categories**,
covering **7 OWASP LLM Top 10** and **3 OWASP Top 10** categories, mapping
enforced by the loader. The pipeline is verified live to the deployed target
(`copilot@c1f011e`, transcript capture, detectors); attack-success,
Judge-quality, regression, and cost values await a live nightly campaign.
