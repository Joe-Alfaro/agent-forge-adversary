import { formatDateTime, formatPercent, formatUsd, humanize } from '../lib/format.js'
import type { CostSummary } from '../lib/models.js'

export interface CostPanelProps {
  cost: CostSummary
}

export function CostPanel({ cost }: CostPanelProps) {
  const targetSpend = cost.byRole.find((entry) => entry.role === 'target')?.spendUsd ?? 0
  // Shares divide by the unrounded role total; totalUsd is rounded to cents for display.
  const roleTotal = cost.byRole.reduce((sum, entry) => sum + entry.spendUsd, 0)
  const share = (spend: number) => (roleTotal === 0 ? 0 : spend / roleTotal)

  return (
    <div className="cost-panel">
      <dl className="stat-row">
        <div className="stat">
          <dt>Total spend ({cost.periodLabel.toLowerCase()})</dt>
          <dd>{formatUsd(cost.totalUsd)}</dd>
        </div>
        <div className="stat">
          <dt>Target's own share</dt>
          <dd>{formatPercent(share(targetSpend))}</dd>
        </div>
        <div className="stat">
          <dt>Projected monthly</dt>
          <dd>{formatUsd(cost.projectedMonthlyUsd)}</dd>
        </div>
      </dl>

      <section aria-labelledby="cost-by-role">
        <h2 id="cost-by-role">Spend by agent role</h2>
        <table className="data-table">
          <thead>
            <tr>
              <th scope="col">Role</th>
              <th scope="col">Spend</th>
              <th scope="col">Share</th>
            </tr>
          </thead>
          <tbody>
            {cost.byRole.map((entry) => (
              <tr key={entry.role}>
                <td>{humanize(entry.role)}</td>
                <td>{formatUsd(entry.spendUsd)}</td>
                <td>{formatPercent(share(entry.spendUsd))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section aria-labelledby="cost-by-run">
        <h2 id="cost-by-run">Spend by run</h2>
        <table className="data-table">
          <thead>
            <tr>
              <th scope="col">Run</th>
              <th scope="col">Started</th>
              <th scope="col">Spend</th>
            </tr>
          </thead>
          <tbody>
            {cost.byRun.map((entry) => (
              <tr key={entry.runId}>
                <td>{entry.runId}</td>
                <td>{formatDateTime(entry.startedAt)}</td>
                <td>{formatUsd(entry.spendUsd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  )
}
