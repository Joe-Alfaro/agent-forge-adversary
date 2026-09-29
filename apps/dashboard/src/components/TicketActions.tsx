import { useForm } from '@tanstack/react-form'

import type { TicketUpdate } from '../lib/data-source.js'
import { humanize } from '../lib/format.js'
import { useUpdateTicket } from '../lib/mutations.js'
import { type ExploitStatus, nextStatuses, type TicketRow } from '../lib/tickets.js'

export interface TicketActionsProps {
  ticket: TicketRow
}

function isExploitStatus(value: string, allowed: readonly ExploitStatus[]): value is ExploitStatus {
  return allowed.some((status) => status === value)
}

/** Status workflow and assignee for one ticket (Section 15.1 actions). */
export function TicketActions({ ticket }: TicketActionsProps) {
  const mutation = useUpdateTicket()
  const statuses = [ticket.status, ...nextStatuses(ticket.status)]
  const defaultValues: TicketUpdate = { status: ticket.status, assignee: ticket.assignee ?? '' }

  const form = useForm({
    defaultValues,
    onSubmit: async ({ value, formApi }) => {
      await mutation.mutateAsync({ id: ticket.id, update: value })
      // The saved values become the new baseline, so Save disables again.
      formApi.reset(value)
    },
  })

  return (
    <form
      className="panel-form"
      aria-label="Update ticket"
      onSubmit={(event) => {
        event.preventDefault()
        void form.handleSubmit()
      }}
    >
      <form.Field name="status">
        {(field) => (
          <label>
            Status
            <select
              name={field.name}
              value={field.state.value}
              onChange={(event) => {
                const next = event.target.value
                if (isExploitStatus(next, statuses)) {
                  field.handleChange(next)
                }
              }}
            >
              {statuses.map((status) => (
                <option key={status} value={status}>
                  {humanize(status)}
                </option>
              ))}
            </select>
          </label>
        )}
      </form.Field>
      <form.Field name="assignee">
        {(field) => (
          <label>
            Assignee
            <input
              name={field.name}
              value={field.state.value}
              placeholder="Unassigned"
              onChange={(event) => field.handleChange(event.target.value)}
            />
          </label>
        )}
      </form.Field>
      <form.Subscribe selector={(state) => [state.isDefaultValue, state.isSubmitting] as const}>
        {([isDefaultValue, isSubmitting]) => (
          <button type="submit" disabled={isDefaultValue || isSubmitting}>
            Save
          </button>
        )}
      </form.Subscribe>
      {mutation.isError && (
        <p role="alert" className="form-error">
          {mutation.error.message}
        </p>
      )}
      {mutation.isSuccess && <p role="status">Saved.</p>}
    </form>
  )
}
