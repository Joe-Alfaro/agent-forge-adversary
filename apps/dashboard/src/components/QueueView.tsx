import { useState } from 'react'

import { formatDateTime, formatUsd } from '../lib/format.js'
import { useMoveQueueItem, useRemoveQueueItem, useRunNow } from '../lib/mutations.js'
import { useQueue } from '../lib/queries.js'
import { estimateRunNow, type RunNowScope } from '../lib/run-now.js'
import { planTonightRows } from '../lib/tonight.js'
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

  // The Orchestrator applies the plan's budget; before it has planned, the configured envelope.
  const envelopeUsd = queue.plan?.budgetUsd ?? queue.envelopeUsd
  const rows = planTonightRows(queue.items, queue.plan?.items ?? [], envelopeUsd)
  const running = rows.filter((row) => row.decision === 'run')
  const spent = running.at(-1)?.cumulativeUsd ?? 0
  const cutCount = rows.length - running.length
  const costs = rows.map((row) => ({ id: row.key, estimatedCostUsd: row.costUsd }))
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
            Run on {queue.runDate}. {running.length} of {rows.length} items will run for {formatUsd(spent)} of the{' '}
            {formatUsd(envelopeUsd)} envelope{cutCount > 0 ? `; ${cutCount} cut.` : '.'}
          </p>
          {queue.plan ? (
            <p className="muted">
              Planned by the Orchestrator at {formatDateTime(queue.plan.producedAt)} for {queue.plan.targetVersion}.
              Coverage campaigns are ranked by priority and read-only; reorder or remove operator requests.
            </p>
          ) : (
            <p className="muted">The Orchestrator has not planned tonight yet; showing operator requests only.</p>
          )}
        </div>
        <button
          type="button"
          disabled={!queue.runNowEnabled || queue.items.length === 0}
          onClick={() => openDialog({ kind: 'queue' })}
        >
          Run queue now
        </button>
      </header>
      {!queue.runNowEnabled && (
        <p className="muted">Run now executes in the local demo; it is turned off on this deployment.</p>
      )}
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
      {queue.plan && queue.plan.notes.length > 0 && (
        <ul className="plan-notes" aria-label="Orchestrator notes">
          {queue.plan.notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      )}
      {error && (
        <p role="alert" className="form-error">
          {error.message}
        </p>
      )}
      <div className="queue-table">
        <QueueTable
          rows={rows}
          busy={remove.isPending || move.isPending}
          onRemove={(id) => remove.mutate(id)}
          onMove={(id, direction) => move.mutate({ id, direction })}
          onRunNow={(id) => openDialog({ kind: 'single', operatorRequestId: id })}
          runNowDisabled={!queue.runNowEnabled}
        />
      </div>
      {scope && (
        <RunNowDialog
          scope={scope}
          estimate={estimateRunNow(costs, scope, envelopeUsd)}
          pending={run.isPending}
          {...(run.error ? { error: run.error.message } : {})}
          onConfirm={() => confirm(scope)}
          onCancel={() => setScope(null)}
        />
      )}
    </>
  )
}
