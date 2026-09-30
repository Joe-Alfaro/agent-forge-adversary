import { createFileRoute } from '@tanstack/react-router'

import { JudgeHealthPanel } from '../components/JudgeHealthPanel.js'
import { ReviewQueue } from '../components/ReviewQueue.js'
import { judgeHealthQuery, needsReviewQuery, useJudgeHealth } from '../lib/queries.js'

export const Route = createFileRoute('/judge')({
  loader: ({ context }) =>
    Promise.all([
      context.queryClient.ensureQueryData(judgeHealthQuery),
      context.queryClient.ensureQueryData(needsReviewQuery),
    ]),
  component: JudgePage,
})

function JudgePage() {
  const { data: health, dataUpdatedAt } = useJudgeHealth()
  return (
    <>
      <header className="page-header">
        <h1>Judge health</h1>
        <p>
          Verdicts the Judge could not settle wait here for a human (gate G7). A decision is stored as a human verdict
          and a ground-truth label; the Judge's own verdict is kept as it was.
        </p>
      </header>
      <JudgeHealthPanel health={health} now={new Date(dataUpdatedAt)} />
      <section aria-labelledby="needs-review">
        <h2 id="needs-review">Needs review</h2>
        <ReviewQueue />
      </section>
    </>
  )
}
