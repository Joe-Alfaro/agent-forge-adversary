# Users

AgentForge is a single-team internal tool: one shared operator login, one target,
designed so adding targets is a config change (ARCHITECTURE.md §2.3). Three human
roles interact with it. None of them prompt the target by hand — the platform
runs a red team every night and on demand, and people work through the Operator
Dashboard (§15.1) and the morning report.

## 1. Security engineer / Operator (primary)

**Job to be done:** know what is vulnerable in the Co-Pilot right now, decide what
to test next, and keep false positives from wasting the dev team's time.

- **Nightly run:** the operator does not babysit it. A scheduled job (default
  01:00 CT) drains the queue in a fixed order — operator rerun requests, then
  regressions owed to a changed target, then coverage-driven campaigns — inside a
  budget envelope (§7.0). The operator sets the allowed categories and the
  envelope; everything inside runs unattended.
- **Morning report** (`NightlyRunSummary`): the first thing they read each day —
  what ran, what was found, what regressed, what it cost, and what was cut for
  budget. It is the triage queue for the day.
- **Dashboard:** they live in the Findings ticket tracker — change status
  (`open → in_progress → fixed → verified`, or `false_positive`), assign, add
  notes, and read the minimal repro, transcript, and detector evidence per
  ticket. They resolve `needs_review` verdicts (which feed the Judge's ground
  truth), watch the Coverage heatmap for gaps, and read the Cost and Judge-health
  panels.
- **Queue & chat:** they queue a re-check for tonight from a ticket ("Re-check
  tonight"), reorder or cut tonight's items, and ask the Orchestrator questions
  in the docked chat ("what is open and why", "focus on exfiltration tonight").
  Every chat directive is echoed and confirmed before it is enqueued (§4.5, G9).
- **Gated actions:** they alone approve publication of high/critical reports,
  change the target allowlist (with a second approver), raise the budget, enable a
  category, or press "Run now" outside the window (§10, gates G1–G10).

## 2. Co-Pilot development team

**Job to be done:** understand and fix a reported vulnerability without having
been present when it was found, then confirm the fix holds.

- **Reports:** they consume published `VulnReport`s — reproduction steps, observed
  vs expected behaviour, clinical impact, OWASP mapping, and a remediation
  recommendation (clearly labelled a recommendation; the platform never edits
  their code, §2.3, G6).
- **Fix → regression loop:** when they deploy a fix and mark the ticket `fixed`,
  that queues a targeted regression for the exploit's family on the next run; a
  new target version (detected via `/health`'s `build_commit`) queues the full
  suite (§7.4). A pass requires the minimal repro, every stored variant, and a
  fresh batch of mutations all to fail, and the clean-control answer to still
  work — so "behaviour changed" cannot masquerade as "fixed" (§9.2).
- They rarely touch the dashboard directly; they receive reports and see ticket
  status flip to `verified` (or `regressed`) after the next run.

## 3. Reviewer / second approver

**Job to be done:** be the human gate where an autonomous mistake is expensive.

- Approves or rejects publication of `critical`/`high` findings before they reach
  the dev team, so a false critical never erodes trust (§10, G4).
- Co-signs adding or changing a target in the allowlist (G1) and other
  scope-expanding changes.
- Uses the ticket detail (evidence, confidence, stage that produced the verdict)
  and the Judge-health panel to weigh whether a finding is real before approving.

## How the pieces serve them

The dashboard is built on the **same queries the Orchestrator reads**, so the
human and the agent see the same numbers (§15.1). Confidence is shown numerically
on every verdict and report, with the stage that produced it, so a reviewer can
tell a detector-proven finding from a low-confidence LLM one. Everything an agent
did overnight is reconstructable step by step from the audit log, and every chat
directive carries the user who confirmed it (§16).
