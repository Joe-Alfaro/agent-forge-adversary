import { createFileRoute } from '@tanstack/react-router'

import { ResilienceChart } from '../components/ResilienceChart.js'
import { resilienceQuery, useResilienceTrend } from '../lib/queries.js'

export const Route = createFileRoute('/resilience')({
  loader: ({ context }) => context.queryClient.ensureQueryData(resilienceQuery),
  component: ResiliencePage,
})

function ResiliencePage() {
  const { data } = useResilienceTrend()
  return (
    <>
      <header className="page-header">
        <h1>Resilience trend</h1>
        <p>
          Confirmed exploits per 100 novel attempts on each target version (M4). Falling is the goal, but read it with
          coverage (M5) and Judge health: a fall is only good news if coverage did not fall with it.
        </p>
      </header>
      <ResilienceChart trend={data} />
    </>
  )
}
