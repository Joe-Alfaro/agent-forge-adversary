import { createColumnHelper } from '@tanstack/react-table'
import { useMemo } from 'react'

import { formatPercent, humanize } from '../lib/format.js'
import { sortForTriage, type TicketRow } from '../lib/tickets.js'
import { DataTable } from './DataTable.js'

const column = createColumnHelper<TicketRow>()

const columns = [
  column.accessor('id', { header: 'ID' }),
  column.accessor('severity', {
    header: 'Severity',
    cell: (info) => <span className={`badge severity-${info.getValue()}`}>{info.getValue()}</span>,
  }),
  column.accessor('category', { header: 'Category', cell: (info) => humanize(info.getValue()) }),
  column.accessor('owaspIds', { header: 'OWASP', cell: (info) => info.getValue().join(', ') }),
  column.accessor('status', {
    header: 'Status',
    cell: (info) => <span className={`badge status-${info.getValue()}`}>{humanize(info.getValue())}</span>,
  }),
  column.accessor('assignee', {
    header: 'Assignee',
    cell: (info) => info.getValue() ?? <span className="muted">Unassigned</span>,
  }),
  column.accessor('confidence', { header: 'Confidence', cell: (info) => formatPercent(info.getValue()) }),
  column.accessor('familySize', { header: 'Family size' }),
]

export interface TicketTableProps {
  rows: readonly TicketRow[]
}

export function TicketTable({ rows }: TicketTableProps) {
  const data = useMemo(() => sortForTriage(rows), [rows])
  return (
    <DataTable
      data={data}
      columns={columns}
      caption="Findings in triage order"
      emptyMessage="No findings yet."
    />
  )
}
