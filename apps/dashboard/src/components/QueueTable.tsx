import { createColumnHelper } from '@tanstack/react-table'

import { formatDateTime, formatUsd, humanize } from '../lib/format.js'
import type { PlannedQueueItem } from '../lib/models.js'
import type { MoveDirection } from '../lib/queue.js'
import { DataTable } from './DataTable.js'
import { TicketLink } from './TicketLink.js'

export interface QueueTableProps {
  plan: PlannedQueueItem[]
  onRemove: (id: string) => void
  onMove: (id: string, direction: MoveDirection) => void
  /** Opens the run-now confirmation for one request; the button is hidden without it. */
  onRunNow?: (id: string) => void
  /** Shows Run this now but disabled, e.g. when the deployment has Run now off. */
  runNowDisabled?: boolean
  /** Disables the controls while an edit is in flight. */
  busy?: boolean
}

function QueueTarget({ item }: { item: PlannedQueueItem }) {
  if (item.exploitId) {
    return <TicketLink id={item.exploitId} />
  }
  if (item.category) {
    return <>{humanize(item.category)}</>
  }
  return <span className="muted">None</span>
}

const column = createColumnHelper<PlannedQueueItem>()

export function QueueTable({ plan, onRemove, onMove, onRunNow, runNowDisabled = false, busy = false }: QueueTableProps) {
  const last = plan.length
  const columns = [
    column.accessor('position', { header: '#' }),
    column.accessor('kind', { header: 'Request', cell: (info) => humanize(info.getValue()) }),
    column.display({ id: 'target', header: 'Target', cell: ({ row }) => <QueueTarget item={row.original} /> }),
    column.accessor('reason', {
      header: 'Reason',
      cell: (info) => info.getValue() ?? <span className="muted">None</span>,
    }),
    column.accessor('requestedBy', {
      header: 'Requested by',
      cell: ({ row }) => `${row.original.requestedBy} via ${row.original.source}`,
    }),
    column.accessor('requestedAt', { header: 'Requested', cell: (info) => formatDateTime(info.getValue()) }),
    column.accessor('estimatedCostUsd', { header: 'Est. cost', cell: (info) => formatUsd(info.getValue()) }),
    column.accessor('cumulativeUsd', {
      header: 'Running total',
      cell: ({ row }) => (
        <>
          {formatUsd(row.original.cumulativeUsd)}
          {row.original.cut && <span className="badge cut">Will be cut</span>}
        </>
      ),
    }),
    column.display({
      id: 'actions',
      header: 'Actions',
      cell: ({ row }) => {
        const { id, position } = row.original
        return (
          <span className="row-actions">
            <button type="button" aria-label={`Move request ${position} up`} disabled={busy || position === 1} onClick={() => onMove(id, 'up')}>
              ↑
            </button>
            <button type="button" aria-label={`Move request ${position} down`} disabled={busy || position === last} onClick={() => onMove(id, 'down')}>
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
      },
    }),
  ]

  return (
    <DataTable
      data={plan}
      columns={columns}
      caption="Tonight's queue in run order"
      emptyMessage="Nothing queued for tonight."
    />
  )
}
