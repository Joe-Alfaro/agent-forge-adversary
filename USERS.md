# Target Users and Use Cases

**Deliverable:** the users the AgentForge adversarial platform serves, their workflows, and the use cases each one justifies, with an explicit argument for why automation is the right answer in each case.
**Source of truth:** every agent, panel, and gate in `ARCHITECTURE.md` must trace to a use case here. Capabilities without a use case in this document do not get built.
**Companion documents:** `ARCHITECTURE.md` (how the platform is built), `KEY_METRICS.md` (how we know it works), `THREAT_MODEL.md` (what it attacks).

---

## 1. Who this is for

The Clinical Co-Pilot (`openemr-base-clean/USERS.md`) serves a covering physician. AgentForge does not serve her directly. It serves the three people who stand between her and a Co-Pilot that leaks a patient's chart, and it is judged by whether those three can do their jobs without it turning into a second full-time job.

### Primary user: Priya Natarajan, application security engineer

The one person at OpenEMR whose job includes the Co-Pilot's security, alongside the rest of the product's. She did the original manual red-team of the Co-Pilot in Phase 2 with a spreadsheet of prompts, and she is the reason this platform exists: the spreadsheet found real problems and then went stale in a week.

| Attribute | Value |
|---|---|
| Share of her week available for the Co-Pilot | **About four hours** |
| Security background | Strong: web application security, OWASP, threat modeling |
| LLM background | Working knowledge; not a prompt-engineering specialist |
| When she looks at the Co-Pilot's security | Mornings, before standup, and after a deploy |
| Tolerance for a false alarm | Low. A false critical costs her a morning and costs her credibility with the developers she escalates to. |
| Tolerance for a miss | Lower. A PHI leak that reaches a physician's screen is a reportable incident. |

**What she is doing when she opens the platform.** It is 8:40 AM. The nightly run finished at 4:00. She has twenty minutes before standup, in which she needs to know three things: did anything new get through last night, did anything that was fixed come back, and is there anything she has to escalate before the 10:00 deploy. She is not going to read transcripts. She is going to read a list, sorted so the thing that matters is at the top, and open at most two of them.

**What she does with the output.** She changes ticket statuses, assigns two to a developer with a link, and queues a re-check on the one the developer says he fixed yesterday. If the platform is wrong in front of that developer, he stops reading her tickets. There is a second chance with this user, but not a third.

### Secondary user: Marcus Oyelaran, Co-Pilot developer

Owns `copilot-service/`. Did not build the platform, will not run it, and was not present when any exploit was found. He receives tickets.

| Attribute | Value |
|---|---|
| What he needs from a ticket | A reproduction he can run in under five minutes, the exact observed and expected behavior, and a remediation he can evaluate, not a lecture |
| What he does after a fix | Marks the ticket fixed and expects to be told, without asking, whether the fix held |
| What makes him ignore the platform | A report he cannot reproduce, or a "fixed" ticket that reopens with no explanation of what changed |

The PRD sets the bar for him exactly: a senior engineer who was not there must be able to reproduce, validate, and fix the vulnerability from the report alone. Every field in the report schema exists because Marcus needs it.

### Decision maker: the CISO

Reads none of the tickets. Asks one question, roughly monthly and always before a scope expansion: **is the Co-Pilot getting safer or less safe, and can I show that to the board?** Wants one chart, one number, and a reason to believe the number. Will not accept "we ran ten thousand attacks" as an answer, because it is not one.

---

## 2. Why these users, and not others

Two alternatives were considered and rejected.

**The Co-Pilot developers as primary users** (developer-run security tests, like unit tests). Rejected because the conflict of interest the PRD warns about applies to people as well as agents: the person who wrote the safeguard is the worst-placed person to decide whether an attack got past it. Developers receive findings; they do not adjudicate them.

**An external red team as primary user** (the platform as a pentester's toolkit). Rejected because the PRD's core requirement is continuity: the value is in re-running every night and catching regressions, which is an operations job, not an engagement. A toolkit optimizes for the cleverest single exploit; Priya needs the boring one that came back on Tuesday.

Choosing the in-house security engineer as the primary user is what forces the platform's shape: a morning report rather than a live console, a ticket tracker rather than a findings dump, and human gates placed where her credibility is at stake.

---

## 3. Use cases

Each use case names the user, the trigger, what they need, and why a human cannot do it unaided. The last column is the justification the PRD asks for.

### UC1 — Morning triage

**User:** Priya. **Trigger:** the nightly run finished. **Needs:** the morning report and the findings list sorted for triage, with new tickets, regressed tickets, and anything awaiting her approval at the top. **Platform capabilities:** nightly cadence (`ARCHITECTURE.md` §7.0), Findings tracker and Run history panels (§15.1), Documentation Agent drafts (§4.4), approval gate G4 (§10).

**Why automation:** the attacks themselves ran overnight without her. That is the whole point: with four hours a week she cannot run hundreds of multi-turn attacks by hand, and she certainly cannot re-run last month's in addition. The human part, deciding what to escalate, is kept human.

### UC2 — Re-check after a fix

**User:** Marcus, then Priya. **Trigger:** Marcus marks a ticket fixed. **Needs:** to know by tomorrow morning whether the fix held against the original exploit, its stored variants, fresh mutations, and the clean control. **Platform capabilities:** Re-check tonight button and the operator queue (§7.0, §15.1), Regression Harness with family semantics (§9), ticket status workflow.

**Why automation:** a fix that blocks the exact phrasing and nothing else looks identical to a real fix when a human tests it once. Checking the whole variant family plus new mutations every time is tedious enough that nobody does it manually, which is how "fixed" vulnerabilities reappear. The PRD calls this out as worse than no test at all.

### UC3 — Release gate

**User:** Priya. **Trigger:** a new Co-Pilot version is deployed, detected from the version header. **Needs:** the full regression suite against the new version before she signs off, and a per-category comparison with the previous version so a fix in one place that opens a hole elsewhere is flagged. **Platform capabilities:** regression triggers (§7.4), cross-category comparison (§9.4), Run now with cost confirmation (G10) when the deploy cannot wait for tonight.

**Why automation:** a manual retest covers what the tester remembers. The regression suite covers what the platform has ever confirmed, which within a month will be more than any one person remembers.

### UC4 — Following a lead

**User:** Priya. **Trigger:** a partial success in last night's run, or a new technique she read about. **Needs:** to point the red team at a category or a specific ticket tonight, and to ask the Orchestrator why it spent the budget the way it did. **Platform capabilities:** Orchestrator chat with the four write tools and confirm-before-enqueue (§4.5), tonight's queue panel, Red Team mutation into variant families (§4.2).

**Why automation:** the PRD's example is exact: take a partially successful attack and generate ten variants to find the one that breaks through. A person can do that for one attack. The platform does it for every partial success, every night, and Priya's contribution is choosing where to point it.

### UC5 — Reproducing a finding cold

**User:** Marcus. **Trigger:** a ticket assigned to him. **Needs:** minimal reproduction, observed versus expected behavior, clinical impact, severity, and a remediation recommendation, all from the ticket, with no conversation required. **Platform capabilities:** Documentation Agent with schema validation and deduplication (§4.4), delta-debugged minimal repro (§9.3), transcript and detector evidence attached to the ticket.

**Why automation:** the person who found the exploit was an agent, at 2:00 AM. There is no human author to ask. The report has to be complete by construction, which is why its schema is validated before it is written and why the reproduction is re-verified by the harness before the report is drafted.

### UC6 — Answering the CISO

**User:** the CISO, via Priya. **Trigger:** monthly review or a scope decision. **Needs:** the resilience trend (regression pass rate and confirmed-exploit rate per target version), coverage of the threat model, and spend, in one view. **Platform capabilities:** Resilience trend, Coverage, and Cost panels (§15.1), `coverage_snapshots` and `nightly_runs` tables (§14.3), `KEY_METRICS.md`.

**Why automation:** the trend only exists if the same tests run against every version with the same judge. A human-run program produces incomparable snapshots; the platform produces a series.

### UC7 — Trusting the judge

**User:** Priya. **Trigger:** a `needs_review` verdict, or a nightly calibration alert. **Needs:** to resolve low-confidence verdicts quickly, and to be told when the Judge's agreement with ground truth drops. **Platform capabilities:** three-stage Judge with detectors authoritative (§8.1), ground-truth set and nightly calibration (§8.3), Judge health panel and review queue (§15.1, G7).

**Why automation, and why not:** the Judge automates the verdict; the ground-truth set keeps that automation honest, and it is built from Priya's own reviews. This is the one place where the platform deliberately asks her for more work, because a Judge that agrees with everything would make every other use case worthless.

---

## 4. What the users constrain

| Constraint | Set by | Consequence in the architecture |
|---|---|---|
| One run per night, report by morning | Priya's four hours a week and her 8:40 AM window | Nightly cadence with a budget envelope; no continuous loop (§7.0, §17.9) |
| Zero false criticals published without a human | Priya's credibility with Marcus | Gate G4: high and critical reports need her approval; medium and low auto-publish after 24 hours (§10) |
| Reports reproducible cold | Marcus was not there | Report schema validated before write; minimal repro re-verified (§4.4, §9.3) |
| "Fixed" must mean the family is blocked | Marcus expects to be told the fix held | Four-condition regression pass (§9.2) |
| One trend, comparable across versions | The CISO | Frozen, versioned Judge rubric; rubric hash on every verdict (§8.2) |
| The platform must never attack anything else | The CISO, and the law | Target allowlist behind two-person gate G1; Red Team has no general network access (§16) |
| Cost visible per role on a shared bill | Priya has to defend the spend | Per-role API keys; Cost panel; signal-per-dollar halt (§13) |

---

## 5. What the users do not need, and we do not build

- A live attack console with streaming output. Priya is not watching; she is reading a report.
- Automatic remediation. Marcus fixes code; the platform recommends and then re-tests. Gate G6 is absolute.
- A public or multi-tenant product. One team, one target, one shared login this sprint (§2.3).
- More metrics than `KEY_METRICS.md` lists. The CISO wants one chart, not a dashboard of forty.
