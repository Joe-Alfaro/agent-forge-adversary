import { createFileRoute } from '@tanstack/react-router'

import { CoverageTable } from '../components/CoverageTable.js'
import { coverageQuery, useCoverage } from '../lib/queries.js'

export const Route = createFileRoute('/coverage')({
  loader: ({ context }) => context.queryClient.ensureQueryData(coverageQuery),
  component: CoveragePage,
})

function CoveragePage() {
  const { data } = useCoverage()
  return (
    <>
      <header className="page-header">
        <h1>Coverage</h1>
        <p>Category × subcategory for {data.targetVersion}: attempts, confirmed, last tested.</p>
      </header>
      <CoverageTable cells={data.cells} />
    </>
  )
}
