import { createFileRoute } from '@tanstack/react-router'

import { ActivityFeed } from '../components/ActivityFeed.js'
import { agentEventsQuery, useAgentEvents } from '../lib/queries.js'

export const Route = createFileRoute('/activity')({
  loader: ({ context }) => context.queryClient.ensureQueryData(agentEventsQuery),
  component: ActivityPage,
})

function ActivityPage() {
  const { data } = useAgentEvents()
  return (
    <>
      <header className="page-header">
        <h1>Agent activity</h1>
        <p>
          The latest {data.length} agent events, newest first, refreshed every 15 seconds while a run is going. Langfuse
          stays the debugging surface: events that carry a trace link open it.
        </p>
      </header>
      <ActivityFeed events={data} />
    </>
  )
}
