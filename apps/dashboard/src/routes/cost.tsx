import { createFileRoute } from '@tanstack/react-router'

import { CostPanel } from '../components/CostPanel.js'
import { costQuery, useCost } from '../lib/queries.js'

export const Route = createFileRoute('/cost')({
  loader: ({ context }) => context.queryClient.ensureQueryData(costQuery),
  component: CostPage,
})

function CostPage() {
  const { data } = useCost()
  return (
    <>
      <header className="page-header">
        <h1>Cost</h1>
        <p>Spend per run and per agent role, including the target's own model calls.</p>
      </header>
      <CostPanel cost={data} />
    </>
  )
}
