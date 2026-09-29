import { createFileRoute } from '@tanstack/react-router'

import { RunTable } from '../components/RunTable.js'
import { runsQuery, useRuns } from '../lib/queries.js'

export const Route = createFileRoute('/runs')({
  loader: ({ context }) => context.queryClient.ensureQueryData(runsQuery),
  component: RunsPage,
})

function RunsPage() {
  const { data } = useRuns()
  return (
    <>
      <header className="page-header">
        <h1>Run history</h1>
        <p>One row per nightly or Run now execution, newest first.</p>
      </header>
      <RunTable runs={data} />
    </>
  )
}
