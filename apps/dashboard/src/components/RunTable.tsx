import { createColumnHelper } from '@tanstack/react-table'

import { formatDateTime, formatDuration, formatUsd, humanize } from '../lib/format.js'
import type { RunSummary } from '../lib/models.js'
import { DataTable } from './DataTable.js'

const column = createColumnHelper<RunSummary>()

function VerdictSplit({ verdicts }: Pick<RunSummary, 'verdicts'>) {
  return (
    <span title="success / partial / fail">
      {verdicts.success} / {verdicts.partial} / {verdicts.fail}
    </span>
  )
}

function RunLinks({ run }: { run: RunSummary }) {
  if (!run.reportUrl && !run.traceUrl) {
    return <span className="muted">None</span>
  }
  return (
    <span className="links">
      {run.reportUrl && <a href={run.reportUrl}>Report</a>}
      {run.traceUrl && (
        <a href={run.traceUrl} target="_blank" rel="noreferrer">
          Trace
        </a>
      )}
    </span>
  )
}

const columns = [
  column.accessor('startedAt', { header: 'Started', cell: (info) => formatDateTime(info.getValue()) }),
  column.accessor('trigger', { header: 'Trigger', cell: (info) => humanize(info.getValue()) }),
  column.accessor('status', {
    header: 'Status',
    cell: (info) => <span className={`badge run-${info.getValue()}`}>{info.getValue()}</span>,
  }),
  column.accessor('targetVersion', { header: 'Target version' }),
  column.accessor('attempts', { header: 'Attempts' }),
  column.accessor('verdicts', {
    header: 'Verdicts (S / P / F)',
    cell: (info) => <VerdictSplit verdicts={info.getValue()} />,
  }),
  column.accessor('newTickets', { header: 'New tickets' }),
  column.accessor('regressions', { header: 'Regressions' }),
  column.accessor('spendUsd', { header: 'Spend', cell: (info) => formatUsd(info.getValue()) }),
  column.display({
    id: 'duration',
    header: 'Duration',
    cell: ({ row }) => {
      const { startedAt, finishedAt } = row.original
      if (!finishedAt) {
        return <span className="muted">In progress</span>
      }
      return formatDuration(startedAt, finishedAt)
    },
  }),
  column.display({ id: 'links', header: 'Links', cell: ({ row }) => <RunLinks run={row.original} /> }),
]

export interface RunTableProps {
  runs: RunSummary[]
}

export function RunTable({ runs }: RunTableProps) {
  return <DataTable data={runs} columns={columns} caption="Nightly run history" emptyMessage="No runs yet." />
}
