import { createColumnHelper } from '@tanstack/react-table'

import { formatDateTime, humanize } from '../lib/format.js'
import type { CoverageCell } from '../lib/models.js'
import { DataTable } from './DataTable.js'

const column = createColumnHelper<CoverageCell>()

const columns = [
  column.accessor('category', { header: 'Category', cell: (info) => humanize(info.getValue()) }),
  column.accessor('subcategory', { header: 'Subcategory', cell: (info) => humanize(info.getValue()) }),
  column.accessor('owaspIds', { header: 'OWASP', cell: (info) => info.getValue().join(', ') }),
  column.accessor('attempts', {
    header: 'Attempts',
    cell: (info) => {
      const attempts = info.getValue()
      if (attempts === 0) {
        return <span className="badge untested">untested</span>
      }
      return attempts
    },
  }),
  column.accessor('confirmed', { header: 'Confirmed' }),
  column.accessor('lastRunAt', {
    header: 'Last tested',
    cell: (info) => {
      const lastRunAt = info.getValue()
      if (!lastRunAt) {
        return <span className="muted">Never</span>
      }
      return formatDateTime(lastRunAt)
    },
  }),
]

export interface CoverageTableProps {
  cells: CoverageCell[]
}

export function CoverageTable({ cells }: CoverageTableProps) {
  return (
    <DataTable
      data={cells}
      columns={columns}
      caption="Coverage by category and subcategory"
      emptyMessage="No coverage recorded for this target version."
    />
  )
}
