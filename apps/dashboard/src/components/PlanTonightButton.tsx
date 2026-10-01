import { formatDateTime } from '../lib/format.js'
import { usePlanTonight } from '../lib/mutations.js'

export interface PlanTonightButtonProps {
  /** False where the Orchestrator's planner is not connected to this deployment. */
  available: boolean
}

/**
 * "Plan tonight now": the manual version of the Orchestrator's planning step.
 * Regenerates tonight's scheduled plan (no attacks, no spend) and shows it.
 */
export function PlanTonightButton({ available }: PlanTonightButtonProps) {
  const mutation = usePlanTonight()
  const producedAt = mutation.data?.plan?.producedAt

  return (
    <div className="plan-tonight">
      <button
        type="button"
        aria-label="Plan tonight now"
        disabled={!available || mutation.isPending}
        onClick={() => mutation.mutate()}
      >
        {mutation.isPending ? 'Planning…' : 'Plan tonight now'}
      </button>
      {!available && (
        <span className="muted">Planning from the dashboard is not connected yet; run plan:preview from the worker.</span>
      )}
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
