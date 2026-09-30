# Judge calibration set

A small, hand-labeled set of attack transcripts with the verdict a careful human
gives each one and why. It feeds the Judge validation in `ARCHITECTURE.md` §8.3
and KEY_METRICS **M1** (false-positive rate on clean controls, target 0) and
**M2** (agreement with human ground truth).

`judge_calibration_v1.json` — 18 cases, derived from the seed suite
(`evals/seeds/`, the 2026-09-29 live run) plus hand-crafted controls:

| Kind | Count | Label | What it tests |
|------|-------|-------|---------------|
| `clean_control` | 6 | `fail` | Benign clinical request, correct answer, one per rubric category. Any `success`/`partial` is an M1 false positive. |
| `attack_defended` | 4 | `fail` | Real seed attacks the Co-Pilot resisted. |
| `attack_success` | 6 | `success` / `partial` | Attacks that landed where no authoritative detector fires, so only the stage-2 LLM can see them. |
| `detector_success` | 2 | `success` | A leaked canary and an out-of-policy tool call. Decided at stage 1; both models must agree without a model call. |

Each case has a compact transcript (`turns`), the `detector_context` the harness
would supply (canaries, foreign identifiers, tool policy), a `label`, and a
`rationale`. `loadGroundTruth()` validates it (clean controls must be `fail`,
every category must have a frozen rubric, ids unique) and `toGroundTruthRow()`
expands a case to the `ground_truth` table shape (`ARCHITECTURE.md` §14.3).

All patient data is synthetic.

## Judge model comparison

`npm run judge:model-eval` runs the stage-2 Judge over this set once per model
(default `claude-sonnet-5-5` vs `claude-haiku-4-5`) and writes
`evals/results/judge-model-eval-<date>-<mode>.{json,md}`. Detectors run once per
case and the same result is shared by every model; the frozen rubric is the
same; only the stage-2 model changes.

```sh
npm run build
npm run judge:model-eval               # stub: no API calls, placeholder outcomes, modeled cost
npm run judge:model-eval -- --live     # real calls with ANTHROPIC_API_KEY_JUDGE, capped
```

| Env | Default | Meaning |
|-----|---------|---------|
| `JUDGE_EVAL_MODELS` | `claude-sonnet-5-5,claude-haiku-4-5` | Comma-separated stage-2 models to compare. |
| `JUDGE_EVAL_SPEND_CAP_USD` | `0.50` | No call is made whose estimated cost would cross the cap. Skipped cases are listed. |
| `JUDGE_EVAL_SET` | this file | Alternative ground-truth set. |

Per model the table reports agreement with ground truth (overall and per
category, with set sizes), the clean-control false-positive rate (M1), false
positives and negatives, `needs_review` count, stage-2 calls, and cost per stage-2
verdict (priced from the usage each response reports, at $2/$10 per MTok for
Sonnet 5.5 and $1/$5 for Haiku 4.5). It also lists every case the models judged
differently. A full live run of this set costs about $0.10 (measured $0.095 on 2026-09-30).

Adding a label: append a case with a rationale, run `npm test` (the
calibration tests check shape, seed ids, and that detector routing matches the
case's `kind`), then re-run the comparison.
