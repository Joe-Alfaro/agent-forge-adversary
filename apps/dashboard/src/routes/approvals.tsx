import { createFileRoute } from '@tanstack/react-router'

import { ApprovalsQueue } from '../components/ApprovalsQueue.js'
import { approvalsQuery } from '../lib/queries.js'

export const Route = createFileRoute('/approvals')({
  loader: ({ context }) => context.queryClient.ensureQueryData(approvalsQuery),
  component: ApprovalsPage,
})

function ApprovalsPage() {
  return (
    <>
      <header className="page-header">
        <h1>Approvals</h1>
        <p>
          Report drafts at a human gate. Critical and high need an operator before they publish (G4); medium and low
          publish on their own after a 24-hour review window unless rejected (G5).
        </p>
      </header>
      <ApprovalsQueue />
    </>
  )
}
