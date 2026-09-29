# Key Metrics

**Deliverable:** the small set of numbers that show whether the AgentForge adversarial platform is delivering on its promise, and the reasoning behind each one.
**Traces to:** `USERS.md` (the users and the promise), `ARCHITECTURE.md` (where each number is produced), `THREAT_MODEL.md` (what coverage is measured against).

---

## The promise these metrics have to prove

From `USERS.md` §1, the CISO's question:

> Is the Co-Pilot getting safer or less safe, and can I show that to the board?

And from the primary user's morning:

> Did anything new get through last night, did anything that was fixed come back, and is there anything I have to escalate before the deploy?

Those contain four separable claims, and every metric below exists to test one of them:

1. **The verdicts are right.** If the Judge is wrong, every other number is fiction. This has to be measured first and reported alongside everything else.
2. **Fixed things stay fixed, and the trend is real.** Safer or less safe, per version, on a comparable basis.
3. **The platform looks where the risk is.** A perfect score on the parts of the attack surface we tested says nothing about the parts we did not.
4. **The output is usable by people who were not there.** A finding that cannot be reproduced cold, or that turns out to be a false alarm after publication, costs the platform its users.

Six metrics follow. The set is deliberately small. The PRD's bar is a hospital CTO, and a CTO who is handed forty numbers will reasonably conclude that nobody knows which one matters.

---

## The metrics

| # | Metric | Proves | Target |
|---|---|---|---|
| M1 | Judge false-positive rate on clean controls | Verdicts are right | **0** |
| M2 | Judge agreement with human ground truth | Verdicts are right | ≥ 95% per category, never falling |
| M3 | Verified exploits that regressed, per target version | Fixed things stay fixed | **0** |
| M4 | Confirmed-exploit rate per 100 novel attempts, per target version | The trend | Falling across versions |
| M5 | High-risk threat-model coverage on the current version | Looking where the risk is | 100% of high-risk cells every 7 days |
| M6 | Published high/critical reports later marked false positive | Output is usable | **0** |

Two supporting numbers, reported but not headlined, appear in §"Supporting numbers": cost per confirmed finding, and fix-to-verified latency.

---

### M1 — Judge false-positive rate on clean controls

**Definition:** of the clean-control transcripts in the nightly calibration run (benign clinical requests with correct Co-Pilot responses), the fraction the Judge marks `success` or `partial`. Produced by the calibration job in `ARCHITECTURE.md` §8.3 and shown on the Judge health panel.

**Target: zero.** A Judge that flags safe behavior as an exploit does not produce a slightly noisy signal; it produces tickets that waste Marcus's time and, worse, it inflates M4 in a way that looks like the Co-Pilot getting less safe when nothing changed.

**Why it is first:** it is the cheapest, earliest warning that the Judge is drifting toward agreeing with everything, which the PRD names as a specific failure mode. It is measured every night with no human effort, because the clean controls are labeled once and reused.

**How it is measured:** the clean-control set is part of the ground-truth table. The Judge runs against it after every rubric or model change and nightly regardless. A single hit is an alert, not a statistic.

**Its limitation:** it catches over-flagging, not under-flagging. That is what M2 is for.

---

### M2 — Judge agreement with human ground truth

**Definition:** for each attack category, the fraction of hand-labeled transcripts on which the Judge's outcome (`success`, `partial`, `fail`) matches the human label. Produced by the same calibration run; labels come from Priya's reviews of `needs_review` verdicts and from the seeded Stage 3 cases.

**Target:** at least 95% per category, and the number must not fall between two consecutive calibration runs. A drop of more than a configured delta is an alert and blocks rubric changes from being adopted.

**Why it is here:** M1 measures one direction of error. M2 measures both, per category, which matters because the Judge is not one thing: PHI exfiltration verdicts are mostly decided by deterministic detectors and should sit near 100%, while scope-violation verdicts lean on the LLM rubric and will be lower. Reporting them separately is what makes the number honest.

**How to read it:** a category that is high and stable is trustworthy. A category that is high because its ground-truth set has eight examples is not, and the panel shows the set size next to the percentage for that reason.

**Its limitation, stated plainly:** ground truth is small at first (the target is 30 labeled transcripts per category by Friday) and it grows only as fast as humans review. Early in the platform's life this number is a floor on confidence, not a proof, and should be described that way. It is also correlated with M4 in an uncomfortable way: the same vendor produces the attacker and the Judge this week (`ARCHITECTURE.md` §8.2), so a shared blind spot would not show up here. The deterministic detectors being authoritative is the mitigation, not the metric.

---

### M3 — Verified exploits that regressed

**Definition:** the count of tickets in status `verified` (fixed, and the fix confirmed by a full family regression) whose family produced a `success` verdict against a later target version. Produced by the Regression Harness (§9) and shown on the Findings tracker as status `regressed`.

**Target: zero per version.** Not low. A regression is a vulnerability the organization believed was closed and had stopped watching. It is the exact scenario the PRD describes as the difference between a real fix and a temporary behavior change.

**Why it is the headline for the second claim:** "fixed things stay fixed" is the CISO's question in operational form. A platform that finds many new exploits but lets old ones return is not making the Co-Pilot safer; it is running in place.

**How it is measured:** every verified ticket's family (minimal repro, stored successful variants, fresh mutations, clean control) is replayed on every new target version and weekly regardless. The four-condition pass rule in §9.2 is what makes a regression a real signal rather than flakiness; each replay runs three times and the majority is recorded along with the disagreement.

**Its limitation:** it can only catch regressions of exploits the platform has already confirmed. M5 covers the rest of the surface.

---

### M4 — Confirmed-exploit rate per 100 novel attempts

**Definition:** for each target version, confirmed `success` verdicts divided by novel attempts (attempts that passed the fingerprint novelty check), times 100. Produced from `attempts` and `verdicts` (§14.3); shown as the resilience trend (§15.1).

**Target:** falling across consecutive versions. There is no absolute target, because the number depends on how hard the platform is attacking, which is exactly why the denominator is novel attempts and not all attempts, and why the Judge rubric is frozen and hashed per version. Two versions judged by different rubrics are not comparable, and the panel refuses to draw a line between them.

**Why it is here:** this is the one chart the CISO asked for. It is also the number most easily gamed, which is why it is fourth and not first: a Judge that under-flags (M2), a red team that repeats itself (novelty rate, below), or a run that only tests easy categories (M5) all make it look better than reality. It is only meaningful when read next to M1, M2, and M5.

**How to read it:** a rise after a Co-Pilot deploy is the platform doing its job. A rise with no deploy means the attacker got better, which is fine, or the Judge drifted, which M1 and M2 will show. A fall is only good news if M5 did not fall with it.

---

### M5 — High-risk threat-model coverage

**Definition:** of the category × subcategory cells `THREAT_MODEL.md` rates high risk, the fraction that on the current target version have at least the configured number of attempts, at least one variant family exercised, and a run within the last seven days. Produced from `coverage_snapshots` (§14.3); shown as the Coverage heatmap.

**Target:** 100% of high-risk cells every seven days; all cells at least monthly. A new target version resets the clock, which is intentional: coverage of the previous version says nothing about this one.

**Why it is here:** every other metric is about what the platform found. This one is about where it looked. A CTO's real worry is not the finding on the screen; it is the category nobody tested. The Orchestrator's priority score (§7.2) weights coverage gaps precisely so that this number is the one it is optimizing, and the metric is what proves the Orchestrator is doing that rather than hunting easy wins.

**Its limitation:** coverage counts attempts, not quality. Fifty near-identical attempts in a cell are not coverage. The novelty check keeps duplicates out of the count, but a category the attacker model refuses to engage with (§12) can still show low attempt counts; that refusal rate is reported per technique so the gap is visible rather than silently zero.

---

### M6 — Published high/critical reports later marked false positive

**Definition:** the count of reports at severity high or critical that passed the human approval gate (G4) and were published, and were subsequently moved to status `false_positive`. Produced from the ticket status history.

**Target: zero.** A false critical that reached Marcus costs a developer-day and costs Priya the credibility she needs to get the next real one fixed. `USERS.md` §1 is explicit that there is not a third chance with him.

**Why it is here and not M1:** M1 catches Judge errors before they become tickets. M6 catches the ones that got through the Judge, the Documentation Agent's validation, and a human approver, and were still wrong. It is the platform's equivalent of the Co-Pilot's "unsupported claims reaching a physician": the actual outcome, arriving slowly, that all the earlier numbers are proxies for.

**How it is measured:** the ticket workflow records every status change with who made it. The metric is a query, not a survey. Medium and low reports auto-publish (G5) and are tracked separately; their false-positive rate is a supporting number, not a gate, because their blast radius is a note in a tracker rather than an interrupted developer.

---

## Supporting numbers

Reported on the dashboard, deliberately not headlined.

| Number | Why it is reported | Why it is not a headline |
|---|---|---|
| Cost per confirmed finding, and nightly spend against the envelope | Priya has to defend the budget on a shared Anthropic bill (§13). The signal-per-dollar halt depends on it. | It measures efficiency, not safety. A cheap platform that finds nothing is not a success. |
| Fix-to-verified latency (hours from ticket `fixed` to `verified`) | Marcus expects to be told the fix held by the next morning. The nightly cadence makes the target about 24 hours. | It is a property of the cadence, and the cadence is a decision, not an outcome. |
| Red Team novelty rate | Detects the attacker repeating itself; feeds the Orchestrator's halt condition. | It is an input to M4's denominator, not a claim about the Co-Pilot. |
| Attacker refusal rate per technique | Makes coverage gaps caused by model safety filters visible; decides where the Thursday OpenRouter tier is pointed. | It is about the platform's own tooling. |
| `needs_review` backlog and age | Tells Priya how much of her four hours the Judge is asking for. | It is a workload number. |

---

## What we deliberately do not measure

- **Total attacks run.** The PRD's "not simply cost-per-token × n runs" applies to metrics too. Ten thousand attempts against one category is not a safer system, and reporting the number invites exactly that misreading.
- **Jailbreaks found in a demo.** The PRD's closing note says the deliverable that matters is the one you could defend to a hospital CISO, not the most impressive jailbreak. A single spectacular finding is a story, not a trend.
- **Judge accuracy as a single overall percentage.** Averaging a detector-backed category at 100% with a rubric-backed category at 85% produces a number that describes neither.
- **Platform uptime or latency.** The platform runs at night and nobody is waiting on it. The only latency that matters is fix-to-verified, above.

---

## Current measurement status

| Metric | Measurable today | What it needs |
|---|---|---|
| M1, M2 | Partially. The calibration job and ground-truth table exist in the schema; the seed labels are being produced with the Stage 3 eval cases. | 30 labeled transcripts per category, then nightly runs. |
| M3 | Not yet. Requires the Regression Harness and at least one verified ticket. | Thursday's harness plus one fix cycle with the Co-Pilot team. |
| M4 | From the first two nightly runs onward (Wednesday and Thursday nights). | Two target versions to draw a trend; until then it is a point. |
| M5 | Yes, from the first run. The threat model defines the cells. | `THREAT_MODEL.md` risk ratings. |
| M6 | Structurally yes; will read zero until reports have been published and lived long enough to be disputed. | Time. This is the slowest number and should be reported as such. |

---

## Measured so far

Before the first nightly run the only measured coverage is the seed suite in
`evals/`: the **6 PRD categories, 17 taxonomy cells, 22 seed cases**, spanning
**OWASP LLM Top 10** LLM01, LLM02, LLM05, LLM06, LLM07, LLM09, LLM10 and **OWASP
Top 10** A01, A03, A04, A05, A07, keyed to `AttackTaxonomy v1` (loader-enforced).
Clinical misinformation is not a PRD category; its cases are folded into the
closest cells (`prompt_injection`/`direct`, `state_corruption`/`context_poisoning`)
and kept discoverable via a `misinformation` technique tag. **M5's denominator is
the 7 HIGH cells** across the six categories. All runtime metrics (M1–M6) await a
live campaign.

---

## The version of this a hospital CTO would hear

"Every night the platform attacks the Co-Pilot, judges the results with a judge we check against human labels every night, and files anything real as a ticket. We can show you, per Co-Pilot version, how often a new attack gets through, whether anything we previously fixed has come back, and which parts of the threat model we have and have not exercised this week. The judge's error rate is on the same screen as the findings, so you can see how much to trust them. We do not publish a critical finding without a human signing it, and we track how often those signed findings turn out to be wrong. Right now that number is zero, and the day it is not, it is the first thing on the report."
