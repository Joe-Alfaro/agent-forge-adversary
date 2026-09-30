import { useState } from 'react'

import { formatUsd } from '../lib/format.js'
import { useMoveQueueItem, useRemoveQueueItem, useRunNow } from '../lib/mutations.js'
import { useQueue } from '../lib/queries.js'
import { planTonight } from '../lib/queue.js'
import { estimateRunNow, type RunNowScope } from '../lib/run-now.js'
import { QueueTable } from './QueueTable.js'
import { RunNowDialog } from './RunNowDialog.js'
import { RunNowStatus } from './RunNowStatus.js'

export interface QueueViewProps {
  /** A run-now to follow, e.g. from the URL after a reload. */
  runId?: string
  /** Called with the new run's id once it is scheduled, so the page can keep it in the URL. */
  onRunScheduled?: (runId: string) => void
  onDismissRun?: () => void
  /** How often a scheduled or running run-now is re-read. */
  pollMs?: number
}

/** Tonight's queue: reorder and remove, plus Run now behind a cost confirmation (gate G10). */
export function QueueView({ runId, onRunScheduled, onDismissRun, pollMs = 3_000 }: QueueViewProps) {
  const { data: queue } = useQueue()
  const remove = useRemoveQueueItem()
  const move = useMoveQueueItem()
  const run = useRunNow()
  const [scope, setScope] = useState<RunNowScope | null>(null)
  const [scheduledRunId, setScheduledRunId] = useState<string | undefined>(runId)
  const followed = scheduledRunId ?? runId

  const plan = planTonight(queue.items, queue.envelopeUsd)
  const planned = plan.at(-1)?.cumulativeUsd ?? 0
  const cutCount = plan.filter((item) => item.cut).length
  const error = remove.error ?? move.error

  function openDialog(next: RunNowScope) {
    run.reset()
    setScope(next)
  }

  function confirm(confirmed: RunNowScope) {
    run.mutate(confirmed, {
      onSuccess: (scheduled) => {
        setScope(null)
        setScheduledRunId(scheduled.id)
        onRunScheduled?.(scheduled.id)
      },
    })
  }

  return (
    <>
      <header className="page-header page-header-actions">
        <div>
          <h1>Tonight's queue</h1>
          <p>
            Run on {queue.runDate}. Requested {formatUsd(planned)} against a {formatUsd(queue.envelopeUsd)} envelope
            {cutCount > 0 && `; ${cutCount} request${cutCount === 1 ? '' : 's'} will be cut`}.
          </p>
        </div>
        <button type="button" disabled={queue.items.length === 0} onClick={() => openDialog({ kind: 'queue' })}>
          Run queue now
        </button>
      </header>
      {followed && (
        <RunNowStatus
          runId={followed}
          pollMs={pollMs}
          onDismiss={() => {
            setScheduledRunId(undefined)
            onDismissRun?.()
          }}
        />
      )}
      {error && (
        <p role="alert" className="form-error">
          {error.message}
        </p>
      )}
      <div className="queue-table">
        <QueueTable
          plan={plan}
          busy={remove.isPending || move.isPending}
          onRemove={(id) => remove.mutate(id)}
          onMove={(id, direction) => move.mutate({ id, direction })}
          onRunNow={(id) => openDialog({ kind: 'single', operatorRequestId: id })}
        />
      </div>
      {scope && (
        <RunNowDialog
          scope={scope}
          estimate={estimateRunNow(queue.items, scope, queue.envelopeUsd)}
          pending={run.isPending}
          {...(run.error ? { error: run.error.message } : {})}
          onConfirm={() => confirm(scope)}
          onCancel={() => setScope(null)}
        />
      )}
    </>
  )
}
