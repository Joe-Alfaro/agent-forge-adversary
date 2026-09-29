import { createFileRoute } from '@tanstack/react-router'

import { QueueTable } from '../components/QueueTable.js'
import { formatUsd } from '../lib/format.js'
import { useMoveQueueItem, useRemoveQueueItem } from '../lib/mutations.js'
import { queueQuery, useQueue } from '../lib/queries.js'
import { planTonight } from '../lib/queue.js'

export const Route = createFileRoute('/queue')({
  loader: ({ context }) => context.queryClient.ensureQueryData(queueQuery),
  component: QueuePage,
})

function QueuePage() {
  const { data: queue } = useQueue()
  const remove = useRemoveQueueItem()
  const move = useMoveQueueItem()
  const plan = planTonight(queue.items, queue.envelopeUsd)
  const planned = plan.at(-1)?.cumulativeUsd ?? 0
  const cutCount = plan.filter((item) => item.cut).length
  const error = remove.error ?? move.error

  return (
    <>
      <header className="page-header">
        <h1>Tonight's queue</h1>
        <p>
          Run on {queue.runDate}. Requested {formatUsd(planned)} against a {formatUsd(queue.envelopeUsd)} envelope
          {cutCount > 0 && `; ${cutCount} request${cutCount === 1 ? '' : 's'} will be cut`}.
        </p>
      </header>
      {error && (
        <p role="alert" className="form-error">
          {error.message}
        </p>
      )}
      <QueueTable
        plan={plan}
        busy={remove.isPending || move.isPending}
        onRemove={(id) => remove.mutate(id)}
        onMove={(id, direction) => move.mutate({ id, direction })}
      />
    </>
  )
}
