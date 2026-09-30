import { formatDateTime, formatUsd } from '../lib/format.js'
import type { MorningReport } from '../lib/models.js'
import { TicketLink } from './TicketLink.js'

function TicketList({ title, ids, empty }: { title: string; ids: string[]; empty: string }) {
  const headingId = `report-${title.toLowerCase().replaceAll(' ', '-')}`
  return (
    <section aria-labelledby={headingId}>
      <h2 id={headingId}>{title}</h2>
      {ids.length === 0 && <p className="muted">{empty}</p>}
      {ids.length > 0 && (
        <ul className="ticket-list">
          {ids.map((id) => (
            <li key={id}>
              <TicketLink id={id} />
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

export interface MorningReportViewProps {
  report: MorningReport
}

export function MorningReportView({ report }: MorningReportViewProps) {
  return (
    <article className="morning-report">
      <p className="headline">{report.headline}</p>
      <dl className="stat-row">
        <div className="stat">
          <dt>Attempts</dt>
          <dd>{report.attempts}</dd>
        </div>
        <div className="stat">
          <dt>Verdicts (S / P / F)</dt>
          <dd>
            {report.verdicts.success} / {report.verdicts.partial} / {report.verdicts.fail}
          </dd>
        </div>
        <div className="stat">
          <dt>Spend</dt>
          <dd>{formatUsd(report.spendUsd)}</dd>
        </div>
        <div className="stat">
          <dt>Queue (plan items)</dt>
          <dd>{`${report.queue.ran} ran, ${report.queue.cut} cut`}</dd>
        </div>
      </dl>
      <TicketList title="New tickets" ids={report.newTickets} empty="No new findings." />
      <TicketList title="Regressions" ids={report.regressions} empty="No regressions." />
      <TicketList title="Verified fixes" ids={report.verifiedFixes} empty="No fixes verified." />
      <section aria-labelledby="report-notes">
        <h2 id="report-notes">Notes</h2>
        {report.notes.length === 0 && <p className="muted">No notes.</p>}
        {report.notes.length > 0 && (
          <ul>
            {report.notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        )}
      </section>
      <p className="muted">
        Generated {formatDateTime(report.generatedAt)} for {report.targetVersion}.
        {report.traceUrl && (
          <>
            {' '}
            <a href={report.traceUrl} target="_blank" rel="noreferrer noopener">
              Open the Langfuse trace
            </a>
          </>
        )}
      </p>
    </article>
  )
}
