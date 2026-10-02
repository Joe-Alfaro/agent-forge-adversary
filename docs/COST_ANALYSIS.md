# AI Cost Analysis

AgentForge red-teams the OpenEMR Clinical Co-Pilot (`copilot@c1f011e`). This is
the Friday cost analysis (ARCHITECTURE §13, §16 Friday deliverable): **measured**
spend from the runs done so far, where the money actually goes, attacker refusal
rates, the Judge model comparison, and a monthly projection.

Every figure below comes from a committed results file, a commit, or a Langfuse
trace listed in [Sources](#sources). Where a number is modeled rather than
billed, it says so.

## Summary

- **Nearly all of the money is spent by the target, not the platform.** On the
  one run with a billed measurement (the model-variant nightly, 42 attempts), the
  platform's own agents cost **$0.50** and the Co-Pilot's answers cost an
  observed **~$9.24**. That is a true total of **~$9.74**, of which the target is
  about 95%.
- **The platform's cost model undercounts the target.** The Co-Pilot reports
  `token_usage` of 0/0 in every transcript, so the target is charged at a flat
  per-turn fallback. At the original $0.05/turn the model-variant run was modeled
  at **$3.395**, about a third of its observed cost. The fallback is now
  **$0.15/turn**, calibrated to that observation.
- **The Claude attacker never refused.** All 7 Haiku variant-generation calls
  returned the requested 5 variants (35 of 35). The open-weight OpenRouter tier
  the architecture planned for refusals (§12) was not needed. It stays behind a
  flag as future work.
- **Haiku 4.5 matches Sonnet 5.5 as the stage-2 Judge on the calibration set, at
  ~37% of the cost per verdict.** Both models had 17/18 agreement and 0/6 false
  positives on clean controls (M1). Run a consistency check before switching.
- **Projection:** about **$150–$290 a month** at one nightly run a night,
  depending on whether model variants run, almost all of it target-side.

## 1. Measured spend per run

All runs are against the deployed Co-Pilot, `copilot@c1f011e`.

| Run | Date (UTC) | Attempts / turns | Platform spend (by role) | Recorded total | Langfuse trace |
|---|---|---|---|---|---|
| Seed eval, one seed per category | 2026-09-29 | 7 / 7 | Judge ~$0.056 (flat estimate, $0.008 × 7) | **$0.056** | [27ce2306](https://us.cloud.langfuse.com/trace/27ce2306-1be8-4350-b6b0-3507ab648bb7) |
| Deterministic nightly (validation) | 2026-09-30 22:09 | 24 / 33 | Judge $0.192 · Red Team $0 · Target $0 recorded | **$0.192** | [6ab90da1](https://us.cloud.langfuse.com/trace/6ab90da1-f650-4956-82e9-91eb0e66983b) |
| Model-variant nightly | 2026-10-01 05:51 | 42 / 58 | Judge $0.441 · Red Team $0.054 · Target $2.900 modeled at $0.05/turn | **$3.395** | [e38382bc](https://us.cloud.langfuse.com/trace/e38382bc-0215-40ec-9d65-d34c8853fc43) |
| Judge model eval (Sonnet vs Haiku), full run | 2026-09-30 23:29 | 18 cases × 2 models | Judge only: Sonnet $0.0696 + Haiku $0.0257 | **$0.095** | n/a (offline harness) |
| Judge model eval, credit-truncated first run | 2026-09-30 23:15 | 15 of 18 cases × 2 | Judge only | **$0.076** | n/a |

Notes on each row:

- **Seed eval:** Judge stages 1 and 2, all 7 verdicts `fail`. The Co-Pilot
  reported no token usage, so target spend was not captured (evals/README.md).
- **Deterministic nightly:** deterministic mutation only (seed, paraphrase,
  payload_splitting, encoding). All 24 verdicts were `fail` from the LLM Judge.
  It ran before the zero-token target fallback existed, so the target is
  recorded as $0.
- **Model-variant nightly:** a Sonnet 5.5 strategy call plus Haiku 4.5 variants
  for 7 coverage cells, 5 model variants and 1 seed each. One `partial` (a
  prompt_injection/multi_turn near-miss), 41 `fail`.
- **Judge model eval:** priced from the usage each response reported, at list
  rates.

Platform spend in the two nightlies is the sum of `agent_events.cost_usd` by
role, which is what the dashboard's Cost panel aggregates. Platform rates are
deliberately conservative: Sonnet-class $3/$15 per MTok everywhere, even for
Haiku calls, and the Judge is charged at least $0.008 per call
(`DEFAULT_COST_MODEL` in `apps/worker/src/orchestrator/run.ts`).

**Platform cost per attempt**, excluding the target:

- Deterministic run: **$0.008** (Judge only).
- Model-variant run: **$0.0118**. That is $0.0105 of Judge plus $0.0013 of Red
  Team generation.

The attacker's model generation is the cheapest line. Across the 7 cells it
used 2,634 input and 3,083 output tokens, modeled at $0.054.

## 2. The shared-credit finding

The Co-Pilot and the platform draw on **one Anthropic bill** (ARCHITECTURE F7),
so the target's spend is the platform's spend. Three things make it hard to
measure.

### The Co-Pilot does not report its usage on the transcript

Every recorded turn has `token_usage: { input_tokens: 0, output_tokens: 0 }`.
The run executor can only charge the target with a flat per-turn fallback.

### The original fallback undercounted about 3×

The model-variant run charged $0.05/turn: 58 turns × $0.05 = **$2.90**. The
target-side draw observed on the shared pool for that run was **~$9.24**, about
**$0.16/turn** (commit `bdc0b4d`). The fallback was raised to **$0.15/turn** in
that commit, and the hard spend cap now uses it.

### True cost of the model-variant run

| Role | Spend | Share |
|---|---|---|
| Target (Co-Pilot), observed | ~$9.24 | ~94.9% |
| Judge (Sonnet 5.5, 42 calls) | $0.441 | ~4.5% |
| Red Team generation (Sonnet strategy + Haiku variants, 7 cells) | $0.054 | ~0.6% |
| **Total** | **~$9.74** | |

Even in the platform's own undercounted model, the target was the largest line:
$2.90 of $3.395, or 85%. Re-priced at the calibrated $0.15/turn, the same run
models at 58 × $0.15 + $0.495 = **$9.20**, within about 6% of the observed total.

### The Co-Pilot's own cost estimate disagrees with the bill

The Co-Pilot puts a `cost_estimate_usd` in each response's `observability`
block, but the adapter does not read it. Summed over the model-variant run's 58
turns it comes to **$2.05**, about $0.035/turn and less than a quarter of the
observed draw.

| Run | Turns | Co-Pilot's own estimate |
|---|---|---|
| Deterministic nightly | 33 | $1.44 |
| Seed eval | 7 | $0.30 |

We have not explained the gap. A balance change on a shared pool cannot
separate the Co-Pilot's calls from any other traffic on it, and the
self-estimate may leave out calls the Co-Pilot makes outside the `/answer`
synthesis step.

**Follow-up:** read `observability.usage` / `cost_estimate_usd` into the
transcript's `token_usage`, and give the Co-Pilot its own API key. ARCHITECTURE
§13.1 items 8 and 9 both call for this. With those in place the target line is
billed directly, not inferred.

### Per-role attribution

The dashboard's Cost panel (`apps/dashboard/src/components/CostPanel.tsx`) shows
spend by agent role (`target`, `judge`, `redteam`), the target's share, and a
monthly projection, all from `agent_events`. The role split above is that same
aggregation over the run's `agent_events`. Until the target reports usage, the
panel's target line is the fallback estimate.

## 3. Attacker refusal rates

The PRD warned that commercial models may refuse offensive workflows.
ARCHITECTURE §12 planned a Thursday open-weight tier through OpenRouter for the
categories where Claude refused, and the Friday deliverable asks for refusal
rates "with and without OpenRouter".

| Measure | Result | Evidence |
|---|---|---|
| Haiku 4.5 variant-generation calls refused | **0 of 7 (0%)** | Each cell's `redteam/generate` event shows `model_variants: 5`. A refused variant call returns no variants (`variantModel.ts`), and the run has 35 model-family attempts. |
| Usable variants returned | **35 of 35 requested** | Same events; tagged `model` in the attempts. |
| Categories covered | prompt_injection (direct, indirect, multi_turn), data_exfiltration (authorization_bypass, cross_patient, phi_leakage), identity_role_exploitation (persona_hijacking) | `coverage` in the run file. |

**What this means for OpenRouter.** The Claude attacker had a 0% refusal rate
on every category we generated for, so the anticipated need for an open-weight
attacker did not materialize. The honest answer to "with and without
OpenRouter" is that the run without it lost nothing to refusals. The router
seam and the OpenRouter tier remain available behind a feature flag as future
work. They would matter if a future technique family starts drawing refusals.

**Caveats:**

- Seven generation calls in three categories is a small sample. tool_misuse,
  state_corruption, denial_of_service and misinformation were not run with model
  variants.
- A refused **strategy** call is not counted separately: it silently falls back
  to "use deterministic mutation". Only variant-call refusals are counted, and
  that counter is not yet persisted to `agent_events`. The 0% above is inferred
  from the variant counts.
- The `refusal_rate: 0` field in the `redteam/generate` events measures
  something else: the share of the **target's** responses that were refusals
  (`campaign.ts`). It is 0 in both nightlies because the Co-Pilot withholds
  unsupported claims instead of answering with refusal text.

## 4. Judge model comparison: a concrete cost lever

`npm run judge:model-eval` runs the stage-2 Judge over an 18-case hand-labeled
calibration set (`evals/ground_truth/judge_calibration_v1.json`):

- 6 clean controls
- 4 defended attacks
- 6 successful or partial attacks that only the LLM stage can see
- 2 detector-decided successes

The detectors and the frozen rubric are held constant; only the model changes.
In the full live run ($0.095), no case was skipped:

| Model | Agreement with labels | Clean-control false positives (M1) | Other false positives / false negatives | Cost per stage-2 verdict |
|---|---|---|---|---|
| claude-sonnet-5-5 | 17/18 (94.4%) | 0/6 | 0 / 0 | $0.00435 |
| claude-haiku-4-5 | 17/18 (94.4%) | 0/6 | 0 / 0 | **$0.00161 (~37%)** |

- **The two models agreed on every case.** Both judged `gt-part-dx-003` (another
  patient's initials and the last digits of their MRN) as `success` where it is
  labeled `partial`, and both sent it to `needs_review`. That looks like a
  question about where the rubric draws the line, not a model gap.
- **Haiku was not consistent between runs.** In the earlier credit-truncated
  run, Haiku false-positived clean control `gt-ctrl-003` (confidence 0.72,
  `needs_review`). That did not recur in the full run.

**What the lever is worth today.** The Judge was 4.5% of the model-variant run's
true cost. Moving stage 2 to Haiku would save roughly 60% of that, about
$0.25–0.30 a night at the current platform rates. That is real but small next
to the target.

The lever grows with attempt volume, because the target's cost can be cut by
deduplication and turn caps while every attempt still needs a verdict.
ARCHITECTURE §12 already names Haiku as the fallback for regression re-judging
at volume.

**Before switching**, run the three-repeat consistency check from ARCHITECTURE
§8.3 (about $0.30) and grow the calibration set toward 30 cases per category.
With 6 controls, one false positive moves M1 by 17 points.

## 5. Monthly projection and cost levers

### Projection at one nightly run per night (30 nights)

| Night type | Per night | Per month |
|---|---|---|
| Deterministic only (like the 24-attempt run), target at $0.15/turn | 33 × $0.15 + $0.192 = **$5.14** | **~$154** |
| Model variants (like the 42-attempt run), observed | **~$9.74** | **~$292** |
| Model variants, modeled at the calibrated fallback | **$9.20** | **~$276** |
| Platform-only share (Judge + Red Team) of the model-variant night | $0.495 | ~$15 |

Bounds and sensitivities:

- **Ceiling:** the hard spend cap and the budget envelope bound every night. The
  envelope is `platform_settings.nightly_budget_usd`, default $25, constrained
  to between $0 and $1,000. The ceiling is therefore 30 × the operator's
  envelope (or the hard cap if lower), whatever the projection says.
- **The target dominates.** About 95% of the bill moves with the Co-Pilot's own
  per-turn cost. Any change on the Co-Pilot side (its model, caching, fewer
  calls per answer) moves the total almost proportionally. The platform-side
  levers below move only the remaining ~5% plus the number of turns we send.
- **Versus the pre-measurement estimate:** ARCHITECTURE §13.3 estimated
  $0.03–0.07 per case. Measured, it is about **$0.23 per attempt** ($9.74 / 42),
  almost entirely target-side. The estimate's target line ($0.02–0.05) was low
  by roughly 3–5×.

### Cost levers built into the architecture, and what the runs show

| Lever | What it does | Observed so far |
|---|---|---|
| **Nightly cadence**, not continuous | One planned run per night plus an operator queue | Bounds spend to one envelope a night. Nothing runs between nights unless an operator presses Run now. |
| **Detectors first** (stage 1 is free) | An authoritative detector hit is a deterministic verdict with no LLM call | 0 of 66 nightly attempts were decided by detectors, because nothing leaked. The ≥40% target (§13.1) only pays off once attacks land. The calibration set confirms detector-decided cases never reach either Judge model. |
| **Deterministic mutation floor** | Paraphrase, encoding, payload splitting and so on need no model | The 24-attempt night spent **$0** on attack generation. Model variants cost $0.054 for 35 attacks. |
| **Budget envelope + hard cap** | The planner cuts items past the envelope. The executor will not start an item whose estimate crosses the hard cap. | Both nightlies finished under their caps. The cap now uses the measured $0.15/turn, so it binds on real cost, not the undercount. |
| **Turn caps and deduplication** | Fingerprint dedup; per-plan `max_turns` | The strongest lever on a target-dominated bill: each avoided turn saves ~$0.15. |
| **Cheaper Judge** (Haiku 4.5) | ~37% of Sonnet's cost per verdict at equal measured agreement | Measured, pending the consistency check (§4). |
| **Per-role API keys** | Attributes spend per role on the shared bill | The Judge has its own key (`ANTHROPIC_API_KEY_JUDGE`). The Co-Pilot does not report usage yet, which is the open gap in §2. |

## Sources

| Figure | Source |
|---|---|
| Seed eval $0.056, 7 cases, trace 27ce2306 | `evals/results/2026-09-29-copilot-c1f011e.json`; `evals/README.md` |
| Deterministic nightly $0.192, 24 attempts / 33 turns, role split, trace 6ab90da1 | `evals/results/run-nightly-validation-20260930-150946.json` (`summary`, `agent_events`) |
| Model-variant nightly $3.395, 42 attempts / 58 turns, role split, `model_variants`, generation tokens, trace e38382bc | `run-nightly-model-variants-20260930-225112.json` (local `nightly_runs` row 4; referenced in `evals/results/near-misses.md`; the file itself is not committed) |
| ~$9.24 observed target-side draw over 58 turns; fallback raised $0.05 → $0.15/turn | commit `bdc0b4d`; `apps/worker/src/orchestrator/run.ts` (`DEFAULT_COST_MODEL`) |
| Co-Pilot self-reported `cost_estimate_usd` sums | the `observability` block of each turn in the run files above |
| Judge comparison table | `evals/results/judge-model-eval-2026-09-30-live.{json,md}`; truncated run in `…-live-partial.{json,md}` |
| Model list prices | ARCHITECTURE §12 (Anthropic first-party rates as of 2026-09-25) |
| Budget envelope default and range | `packages/db/migrations/1727900000000_platform-settings.cjs` |
