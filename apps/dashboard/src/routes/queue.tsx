import { createFileRoute } from '@tanstack/react-router'

import { QueueView } from '../components/QueueView.js'
import { queueQuery } from '../lib/queries.js'

interface QueueSearch {
  /** The run-now being followed, kept in the URL so a reload keeps showing its status. */
  runNow?: string
}

export const Route = createFileRoute('/queue')({
  validateSearch: (search: Record<string, unknown>): QueueSearch =>
    typeof search.runNow === 'string' && search.runNow !== '' ? { runNow: search.runNow } : {},
  loader: ({ context }) => context.queryClient.ensureQueryData(queueQuery),
  component: QueuePage,
})

function QueuePage() {
  const { runNow } = Route.useSearch()
  const navigate = Route.useNavigate()
  return (
    <QueueView
      {...(runNow ? { runId: runNow } : {})}
      onRunScheduled={(runId) => void navigate({ search: { runNow: runId }, replace: true })}
      onDismissRun={() => void navigate({ search: {}, replace: true })}
    />
  )
}
