import { createColumnHelper } from '@tanstack/react-table'

import { type ApprovalDecision, type ApprovalItem, allowedDecisions } from '../lib/approvals.js'
import { formatDateTime, humanize } from '../lib/format.js'
import { useDecideApproval } from '../lib/mutations.js'
import { useApprovals } from '../lib/queries.js'
import { DataTable } from './DataTable.js'
import { TicketLink } from './TicketLink.js'

const DECISION_LABEL: Record<ApprovalDecision, string> = {
  approve: 'Approve and publish',
  reject: 'Reject',
}

const DECISION_DONE: Record<ApprovalDecision, string> = {
  approve: 'published',
  reject: 'rejected',
}

function GateCell({ item }: { item: ApprovalItem }) {
  if (item.gate === 'G4') {
    return <span className="badge gate-g4">G4: needs approval</span>
  }
  return <span className="muted">G5: auto-publishes {item.autoPublishAt ? formatDateTime(item.autoPublishAt) : 'after review'}</span>
}

const column = createColumnHelper<ApprovalItem>()

/** Section 10 gates G4 and G5: report drafts an operator can publish or reject. */
export function ApprovalsQueue() {
  const { data: items } = useApprovals()
  const decide = useDecideApproval()
  const decided = decide.data

  const columns = [
    column.accessor('exploitId', { header: 'Ticket', cell: (info) => <TicketLink id={info.getValue()} /> }),
    column.accessor('severity', {
      header: 'Severity',
      cell: (info) => <span className={`badge severity-${info.getValue()}`}>{info.getValue()}</span>,
    }),
    column.accessor('category', { header: 'Category', cell: (info) => humanize(info.getValue()) }),
    column.accessor('title', {
      header: 'Report',
      cell: ({ row }) => `${row.original.title} (v${row.original.version})`,
    }),
    column.accessor('draftedAt', { header: 'Drafted', cell: (info) => formatDateTime(info.getValue()) }),
    column.display({ id: 'gate', header: 'Gate', cell: ({ row }) => <GateCell item={row.original} /> }),
    column.display({
      id: 'actions',
      header: 'Decision',
      cell: ({ row }) => {
        const { reportId, exploitId, version, status } = row.original
        return (
          <span className="row-actions">
            {allowedDecisions(status).map((decision) => (
              <button
                key={decision}
                type="button"
                aria-label={`${DECISION_LABEL[decision]} ${exploitId} v${version}`}
                disabled={decide.isPending}
                onClick={() => decide.mutate({ reportId, decision })}
              >
                {DECISION_LABEL[decision]}
              </button>
            ))}
          </span>
        )
      },
    }),
  ]

  return (
    <>
      {decide.error && (
        <p role="alert" className="form-error">
          {decide.error.message}
        </p>
      )}
      {decided && decide.variables && (
        <p role="status">
          {decided.exploitId} v{decided.version} {DECISION_DONE[decide.variables.decision]}.
        </p>
      )}
      <DataTable
        data={items}
        columns={columns}
        caption="Reports waiting for a publish decision"
        emptyMessage="No reports are waiting for a decision."
      />
    </>
  )
}
