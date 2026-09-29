import { createFileRoute, Link, notFound } from '@tanstack/react-router'

import { MorningReportView } from '../components/MorningReportView.js'
import { morningReportQuery, useMorningReport } from '../lib/queries.js'

export const Route = createFileRoute('/reports/$runId')({
  loader: async ({ context, params }) => {
    const report = await context.queryClient.ensureQueryData(morningReportQuery(params.runId))
    if (!report) {
      throw notFound()
    }
  },
  component: ReportPage,
  notFoundComponent: () => <p>No morning report for that run yet.</p>,
})

function ReportPage() {
  const { runId } = Route.useParams()
  const { data: report } = useMorningReport(runId)
  if (!report) {
    return <p>No morning report for that run yet.</p>
  }
  return (
    <>
      <header className="page-header">
        <p>
          <Link to="/runs">← Run history</Link>
        </p>
        <h1>Morning report · {report.runId}</h1>
      </header>
      <MorningReportView report={report} />
    </>
  )
}
