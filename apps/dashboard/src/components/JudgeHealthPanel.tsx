import { formatPercent, humanize } from '../lib/format.js'
import type { JudgeHealth } from '../lib/judge.js'

export interface JudgeHealthPanelProps {
  health: JudgeHealth
  now: Date
}

function formatAge(sinceIso: string | undefined, now: Date): string {
  if (!sinceIso) {
    return 'None'
  }
  const hours = Math.max(0, Math.floor((now.getTime() - Date.parse(sinceIso)) / 3_600_000))
  return hours < 48 ? `${hours}h` : `${Math.floor(hours / 24)}d`
}

/**
 * Section 15.1 Judge health, from human review: the needs_review backlog and
 * how often reviewers overturn the Judge. Calibration against the ground-truth
 * set (M1, M2) needs stored calibration runs, which the schema does not have yet.
 */
export function JudgeHealthPanel({ health, now }: JudgeHealthPanelProps) {
  const overturnRate = health.reviewed === 0 ? 0 : health.overturned / health.reviewed

  return (
    <>
      <section aria-label="Judge health">
        <dl className="stat-row">
          <div className="stat">
            <dt>needs_review backlog</dt>
            <dd>{health.backlog}</dd>
          </div>
          <div className="stat">
            <dt>Oldest waiting</dt>
            <dd>{formatAge(health.oldestPendingAt, now)}</dd>
          </div>
          <div className="stat">
            <dt>Overturned by a human</dt>
            <dd>{formatPercent(overturnRate)}</dd>
          </div>
          <div className="stat">
            <dt>Ground-truth labels</dt>
            <dd>{health.groundTruthLabels}</dd>
          </div>
        </dl>
      </section>

      <section aria-labelledby="judge-agreement">
        <h2 id="judge-agreement">Agreement with human review</h2>
        {health.byCategory.length === 0 ? (
          <p className="muted">No human reviews yet.</p>
        ) : (
          <table className="data-table">
            <caption className="visually-hidden">Judge agreement with human review, by category</caption>
            <thead>
              <tr>
                <th scope="col">Category</th>
                <th scope="col">Reviewed</th>
                <th scope="col">Overturned</th>
                <th scope="col">Agreement</th>
              </tr>
            </thead>
            <tbody>
              {health.byCategory.map((entry) => (
                <tr key={entry.category}>
                  <td>{humanize(entry.category)}</td>
                  <td>{entry.reviewed}</td>
                  <td>{entry.overturned}</td>
                  <td>{formatPercent(1 - entry.overturned / entry.reviewed)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="muted">
          Agreement here covers only verdicts a human has reviewed, which skew toward hard cases. Calibration against the
          full ground-truth set (M1 clean-control false positives, M2 agreement) is not shown yet: no table stores
          calibration runs.
        </p>
      </section>
    </>
  )
}
