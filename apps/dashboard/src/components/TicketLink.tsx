import { Link } from '@tanstack/react-router'

export function TicketLink({ id }: { id: string }) {
  return (
    <Link to="/findings/$ticketId" params={{ ticketId: id }}>
      {id}
    </Link>
  )
}
