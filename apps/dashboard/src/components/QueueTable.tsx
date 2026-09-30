import { createColumnHelper } from '@tanstack/react-table'

import { formatDateTime, formatUsd, humanize } from '../lib/format.js'
import type { MoveDirection } from '../lib/queue.js'
import type { OperatorRow, RegressionCause, TonightRow } from '../lib/tonight.js'
import { DataTable } from './DataTable.js'
import { TicketLink } from './TicketLink.js'

export interface QueueTableProps {
  /** Tonight in run order: operator requests, then the plan's coverage campaigns. */
  rows: TonightRow[]
  onRemove: (id: string) => void
  onMove: (id: string, direction: MoveDirection) => void
  /** Opens the run-now confirmation for one request; the button is hidden without it. */
  onRunNow?: (id: string) => void
  /** Shows Run this now but disabled, e.g. when the deployment has Run now off. */
  runNowDisabled?: boolean
  /** Disables the controls while an edit is in flight. */
  busy?: boolean
}

/** planner.ts adds 1000 to the priority of cells in a focused category, so they rank first. */
const FOCUS_BOOST = 1000

function formatPriority(priority: number | undefined): string {
  if (priority === undefined) {
    return ''
  }
  return priority >= FOCUS_BOOST ? `${(priority - FOCUS_BOOST).toFixed(2)} + focus` : priority.toFixed(2)
}

const REGRESSION_CAUSE: Record<RegressionCause, string> = {
  target_changed: 'Target version changed',
  ticket_fixed: 'Ticket moved to fixed',
}

function Target({ row }: { row: TonightRow }) {
  if (row.source === 'orchestrator' && row.exploitId) {
    return <TicketLink id={row.exploitId} />
  }
  if (row.source === 'orchestrator') {
    return <>{row.subcategory ? `${humanize(row.category)} / ${humanize(row.subcategory)}` : humanize(row.category)}</>
  }
  if (row.item.exploitId) {
    return <TicketLink id={row.item.exploitId} />
  }
  if (row.item.category) {
    return <>{humanize(row.item.category)}</>
  }
  return <span className="muted">None</span>
}

function Owasp({ row }: { row: TonightRow }) {
  if (row.source === 'operator' || row.owaspIds.length === 0) {
    return null
  }
  return (
    <ul className="owasp-tags" aria-label="OWASP">
      {row.owaspIds.map((id) => (
        <li key={id} className="badge">
          {id}
        </li>
      ))}
    </ul>
  )
}

function Priority({ row }: { row: TonightRow }) {
  return <>{row.source === 'orchestrator' ? formatPriority(row.priority) : ''}</>
}

function Requested({ row }: { row: TonightRow }) {
  if (row.source === 'orchestrator') {
    return <span className="muted">Orchestrator</span>
  }
  return (
    <>
      {row.item.requestedBy} via {row.item.source}
      <br />
      <span className="muted">{formatDateTime(row.item.requestedAt)}</span>
    </>
  )
}

/**
 * Campaign reasons only restate the priority, so campaigns show their attempt
 * budget; regressions show why they are owed and how many replays.
 */
function reason(row: TonightRow): string | undefined {
  if (row.source === 'operator') {
    return row.item.reason
  }
  if (row.kind === 'regression') {
    const cause = row.regressionCause ? REGRESSION_CAUSE[row.regressionCause] : 'Regression owed'
    return `${cause} · ${row.maxAttempts} replays`
  }
  return `${row.maxAttempts} attempts`
}

const column = createColumnHelper<TonightRow>()

export function QueueTable({ rows, onRemove, onMove, onRunNow, runNowDisabled = false, busy = false }: QueueTableProps) {
  const operatorRows = rows.filter((row): row is OperatorRow => row.source === 'operator')
  const firstOperator = operatorRows[0]?.key
  const lastOperator = operatorRows.at(-1)?.key

  function operatorActions(row: OperatorRow) {
    const { key: id, position } = row
    return (
      <span className="row-actions">
        <button type="button" aria-label={`Move request ${position} up`} disabled={busy || id === firstOperator} onClick={() => onMove(id, 'up')}>
          ↑
        </button>
        <button type="button" aria-label={`Move request ${position} down`} disabled={busy || id === lastOperator} onClick={() => onMove(id, 'down')}>
          ↓
        </button>
        <button type="button" aria-label={`Remove request ${position}`} disabled={busy} onClick={() => onRemove(id)}>
          Remove
        </button>
        {onRunNow && (
          <button type="button" aria-label={`Run request ${position} now`} disabled={busy || runNowDisabled} onClick={() => onRunNow(id)}>
            Run this now
          </button>
        )}
      </span>
    )
  }

  const columns = [
    column.accessor('position', { header: '#' }),
    column.accessor('kind', { header: 'Item', cell: (info) => humanize(info.getValue()) }),
    column.display({ id: 'target', header: 'Target', cell: ({ row }) => <Target row={row.original} /> }),
    column.display({ id: 'owasp', header: 'OWASP', cell: ({ row }) => <Owasp row={row.original} /> }),
    column.display({
      id: 'priority',
      header: 'Priority',
      cell: ({ row }) => <Priority row={row.original} />,
    }),
    column.display({
      id: 'reason',
      header: 'Reason / size',
      cell: ({ row }) => reason(row.original) || <span className="muted">None</span>,
    }),
    column.display({ id: 'requested', header: 'Requested by', cell: ({ row }) => <Requested row={row.original} /> }),
    column.accessor('costUsd', { header: 'Est. cost', cell: (info) => formatUsd(info.getValue()) }),
    column.display({
      id: 'decision',
      header: 'Running total',
      cell: ({ row }) =>
        row.original.decision === 'run' ? (
          <>
            {formatUsd(row.original.cumulativeUsd)}
            <span className="badge will-run">Will run</span>
          </>
        ) : (
          <span className="badge cut">Will be cut</span>
        ),
    }),
    column.display({
      id: 'actions',
      header: 'Actions',
      cell: ({ row }) => (row.original.source === 'operator' ? operatorActions(row.original) : null),
    }),
  ]

  return (
    <DataTable
      data={rows}
      columns={columns}
      caption="Tonight's queue in run order"
      emptyMessage="Nothing queued or planned for tonight."
    />
  )
}
