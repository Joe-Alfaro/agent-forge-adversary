import { useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { useEffect } from 'react'

import { queueQuery, runsQuery, useRunStatus } from '../lib/queries.js'
import { isRunNowActive } from '../lib/run-now.js'

export interface RunNowStatusProps {
  runId: string
  pollMs: number
  onDismiss?: () => void
}

/** Follows a scheduled run-now until the executor finishes it, then links to the result. */
export function RunNowStatus({ runId, pollMs, onDismiss }: RunNowStatusProps) {
  const queryClient = useQueryClient()
  const { data: run, error } = useRunStatus(runId, pollMs)
  const status = run?.status

  // Each transition changes what is queued and what run history shows.
  useEffect(() => {
    if (status) {
      void queryClient.invalidateQueries({ queryKey: queueQuery.queryKey })
      void queryClient.invalidateQueries({ queryKey: runsQuery.queryKey, exact: true })
    }
  }, [status, queryClient])

  if (error) {
    return (
      <p role="alert" className="form-error">
        Could not read run {runId}: {error.message}
      </p>
    )
  }
  if (run === undefined) {
    return <p className="run-now-status">Checking run {runId}…</p>
  }
  if (run === null) {
    return <p className="run-now-status">Run {runId} was not found.</p>
  }

  const active = isRunNowActive(run.status)
  return (
    <div className={`run-now-status run-${run.status}`}>
      <p aria-live="polite">{active ? `Run ${run.id} is ${run.status}.` : `Run ${run.id} ${run.status}.`}</p>
      {run.status === 'completed' && run.hasMorningReport && (
        <Link to="/reports/$runId" params={{ runId: run.id }}>
          Open the morning report
        </Link>
      )}
      {!active && <Link to="/runs">See run history</Link>}
      {onDismiss && !active && (
        <button type="button" onClick={onDismiss}>
          Dismiss
        </button>
      )}
    </div>
  )
}
