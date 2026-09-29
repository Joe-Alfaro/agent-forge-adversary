import { useForm } from '@tanstack/react-form'

import { humanize } from '../lib/format.js'
import { useEnqueueRerun } from '../lib/mutations.js'
import { useQueuePeek } from '../lib/queries.js'
import { buildRerunRequest } from '../lib/queue.js'
import { canRecheckTonight, type TicketRow } from '../lib/tickets.js'

/** Single shared operator login for the sprint (Section 15.1). */
const OPERATOR = 'operator'

export interface RecheckTonightProps {
  ticket: TicketRow
}

export function RecheckTonight({ ticket }: RecheckTonightProps) {
  const queue = useQueuePeek()
  const mutation = useEnqueueRerun()

  const form = useForm({
    defaultValues: { reason: '' },
    onSubmit: async ({ value }) => {
      if (!queue.data) {
        return
      }
      await mutation.mutateAsync(
        buildRerunRequest({
          messageId: crypto.randomUUID(),
          exploitId: ticket.id,
          requestedBy: OPERATOR,
          requestedFor: queue.data.runDate,
          reason: value.reason,
        }),
      )
    },
  })

  return (
    <section className="recheck" aria-labelledby="recheck-heading">
      <h2 id="recheck-heading">Re-check tonight</h2>
      {renderBody()}
    </section>
  )

  // A render helper rather than a nested component, so the form is not remounted on every render.
  function renderBody() {
    if (!canRecheckTonight(ticket.status)) {
      const label = humanize(ticket.status)
      return <p className="muted">{`${label.charAt(0).toUpperCase()}${label.slice(1)} tickets are not re-checked.`}</p>
    }
    if (!queue.data) {
      return <p className="muted">Loading tonight's queue…</p>
    }
    if (mutation.isSuccess) {
      return <p role="status">Queued for tonight.</p>
    }
    const alreadyQueued = queue.data.items.some((item) => item.kind === 'rerun' && item.exploitId === ticket.id)
    if (alreadyQueued) {
      return <p className="muted">Already queued for tonight.</p>
    }
    return (
      <form
        className="panel-form"
        onSubmit={(event) => {
          event.preventDefault()
          void form.handleSubmit()
        }}
      >
        <form.Field name="reason">
          {(field) => (
            <label>
              Reason (optional)
              <input
                name={field.name}
                value={field.state.value}
                placeholder="e.g. focus on exfiltration"
                onChange={(event) => field.handleChange(event.target.value)}
              />
            </label>
          )}
        </form.Field>
        <form.Subscribe selector={(state) => state.isSubmitting}>
          {(isSubmitting) => (
            <button type="submit" disabled={isSubmitting}>
              Re-check tonight
            </button>
          )}
        </form.Subscribe>
        {mutation.isError && (
          <p role="alert" className="form-error">
            {mutation.error.message}
          </p>
        )}
      </form>
    )
  }
}
