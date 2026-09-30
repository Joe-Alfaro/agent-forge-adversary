import { useId } from 'react'

import { formatUsd } from '../lib/format.js'
import type { RunNowEstimate, RunNowScope } from '../lib/run-now.js'

export interface RunNowDialogProps {
  scope: RunNowScope
  estimate: RunNowEstimate
  pending: boolean
  error?: string
  onConfirm: () => void
  onCancel: () => void
}

/**
 * Gate G10 confirmation: the estimated cost, how many requests, and tonight's
 * envelope are shown before anything is scheduled (ARCHITECTURE.md Section 10).
 */
export function RunNowDialog({ scope, estimate, pending, error, onConfirm, onCancel }: RunNowDialogProps) {
  const titleId = useId()
  const title = scope.kind === 'queue' ? 'Run the whole queue now?' : 'Run this request now?'
  const requests = `${estimate.itemCount} request${estimate.itemCount === 1 ? '' : 's'}`

  return (
    <div className="modal-backdrop">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="modal"
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            onCancel()
          }
        }}
      >
        <h2 id={titleId}>{title}</h2>
        <dl className="detail-grid">
          <dt>Requests</dt>
          <dd>{requests}</dd>
          <dt>Estimated cost</dt>
          <dd>{formatUsd(estimate.estimatedUsd)}</dd>
          <dt>Tonight’s envelope</dt>
          <dd>{formatUsd(estimate.envelopeUsd)} (NIGHTLY_BUDGET_USD)</dd>
        </dl>
        {estimate.exceedsEnvelope && (
          <p className="modal-warning">
            Will exceed budget: this estimate exceeds tonight’s {formatUsd(estimate.envelopeUsd)} envelope by{' '}
            {formatUsd(Math.round((estimate.estimatedUsd - estimate.envelopeUsd) * 100) / 100)}.
          </p>
        )}
        <p className="muted">
          This runs outside the nightly window. The dashboard only schedules the run; the executor drains the{' '}
          {scope.kind === 'queue' ? 'queue in order' : 'request'} and writes the morning report.
        </p>
        {error && (
          <p role="alert" className="form-error">
            {error}
          </p>
        )}
        <div className="modal-actions">
          <button type="button" onClick={onCancel} disabled={pending}>
            Cancel
          </button>
          <button type="submit" onClick={onConfirm} disabled={pending} autoFocus>
            Confirm: run now for {formatUsd(estimate.estimatedUsd)}
          </button>
        </div>
      </div>
    </div>
  )
}
