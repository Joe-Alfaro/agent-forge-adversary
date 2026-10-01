import { formatDateTime } from '../lib/format.js'
import { usePlanTonight } from '../lib/mutations.js'

/**
 * "Plan tonight now": the manual version of the Orchestrator's planning step.
 * Regenerates tonight's scheduled plan (no attacks, no spend) and shows it.
 */
export function PlanTonightButton() {
  const mutation = usePlanTonight()
  const producedAt = mutation.data?.plan?.producedAt

  return (
    <div className="plan-tonight">
      <button
        type="button"
        aria-label="Plan tonight now"
        disabled={mutation.isPending}
        onClick={() => mutation.mutate()}
      >
        {mutation.isPending ? 'Planning…' : 'Plan tonight now'}
      </button>
      {mutation.isSuccess && producedAt && (
        <span role="status" className="toast-ok">
          Tonight’s plan regenerated at {formatDateTime(producedAt)}.
        </span>
      )}
      {mutation.error && (
        <span role="alert" className="form-error">
          {mutation.error.message}
        </span>
      )}
    </div>
  )
}
