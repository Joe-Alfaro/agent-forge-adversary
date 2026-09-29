import { createFileRoute } from '@tanstack/react-router'

import { TicketTable } from '../components/TicketTable.js'
import { ticketsQuery, useTickets } from '../lib/queries.js'

export const Route = createFileRoute('/findings')({
  loader: ({ context }) => context.queryClient.ensureQueryData(ticketsQuery),
  component: FindingsPage,
})

function FindingsPage() {
  const { data } = useTickets()
  return (
    <>
      <header className="page-header">
        <h1>Findings</h1>
        <p>One ticket per confirmed exploit, open criticals first.</p>
      </header>
      <TicketTable rows={data} />
    </>
  )
}
