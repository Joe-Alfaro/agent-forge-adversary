import { createFileRoute, Link, notFound } from '@tanstack/react-router'

import { RecheckTonight } from '../components/RecheckTonight.js'
import { TicketActions } from '../components/TicketActions.js'
import { formatPercent, humanize } from '../lib/format.js'
import { queueQuery, ticketQuery, useTicket } from '../lib/queries.js'

export const Route = createFileRoute('/findings/$ticketId')({
  loader: async ({ context, params }) => {
    const [ticket] = await Promise.all([
      context.queryClient.ensureQueryData(ticketQuery(params.ticketId)),
      context.queryClient.ensureQueryData(queueQuery),
    ])
    if (!ticket) {
      throw notFound()
    }
  },
  component: TicketPage,
  notFoundComponent: () => <p>No ticket with that ID.</p>,
})

function TicketPage() {
  const { ticketId } = Route.useParams()
  const { data: ticket } = useTicket(ticketId)
  if (!ticket) {
    return <p>No ticket with that ID.</p>
  }

  return (
    <>
      <header className="page-header">
        <p>
          <Link to="/findings">← Findings</Link>
        </p>
        <h1>{ticket.id}</h1>
        <p>
          <span className={`badge severity-${ticket.severity}`}>{ticket.severity}</span>{' '}
          {humanize(ticket.category)} · {ticket.owaspIds.join(', ')}
        </p>
      </header>
      <dl className="detail-grid">
        <dt>Status</dt>
        <dd>
          <span className={`badge status-${ticket.status}`}>{humanize(ticket.status)}</span>
        </dd>
        <dt>Assignee</dt>
        <dd>{ticket.assignee ?? <span className="muted">Unassigned</span>}</dd>
        <dt>Confidence</dt>
        <dd>{formatPercent(ticket.confidence)}</dd>
        <dt>Family size</dt>
        <dd>{ticket.familySize}</dd>
        <dt>Last verdict</dt>
        <dd>{ticket.lastVerdict ?? <span className="muted">None</span>}</dd>
        <dt>Discovered in</dt>
        <dd>{ticket.discoveredVersion}</dd>
        <dt>Last verified in</dt>
        <dd>{ticket.lastVerifiedVersion ?? <span className="muted">Not yet</span>}</dd>
      </dl>
      <section aria-labelledby="workflow-heading">
        <h2 id="workflow-heading">Workflow</h2>
        {/* Keyed by ticket so navigating between tickets starts a fresh form; saves reset their own baseline. */}
        <TicketActions key={ticket.id} ticket={ticket} />
      </section>
      <RecheckTonight ticket={ticket} />
    </>
  )
}
