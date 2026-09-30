import type { VerdictOutcome } from '@agentforge/contracts'
import { useForm } from '@tanstack/react-form'

import { formatDateTime, formatPercent, humanize } from '../lib/format.js'
import { overturnOptions, type ReviewItem } from '../lib/judge.js'
import { useResolveReview } from '../lib/mutations.js'
import { useNeedsReview } from '../lib/queries.js'

type ResolveReview = ReturnType<typeof useResolveReview>

function OverturnForm({ item, mutation }: { item: ReviewItem; mutation: ResolveReview }) {
  const options = overturnOptions(item.outcome)
  const form = useForm({
    defaultValues: { outcome: options[0] ?? 'fail' },
    onSubmit: async ({ value }) => {
      await mutation.mutateAsync({ verdictId: item.verdictId, review: { decision: 'overturn', outcome: value.outcome } })
    },
  })

  return (
    <form
      className="overturn-form"
      onSubmit={(event) => {
        event.preventDefault()
        void form.handleSubmit()
      }}
    >
      <form.Field name="outcome">
        {(field) => (
          <select
            aria-label={`Overturn ${item.verdictId} to`}
            value={field.state.value}
            onChange={(event) => {
              const next = options.find((option) => option === event.target.value)
              if (next) {
                field.handleChange(next)
              }
            }}
          >
            {options.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        )}
      </form.Field>
      <button type="submit" aria-label={`Overturn ${item.verdictId}`} disabled={mutation.isPending}>
        Overturn
      </button>
    </form>
  )
}

function ReviewCard({ item, mutation }: { item: ReviewItem; mutation: ResolveReview }) {
  const cell = item.subcategory ? `${humanize(item.category)} / ${humanize(item.subcategory)}` : humanize(item.category)
  return (
    <li className="review-card">
      <h2>{cell}</h2>
      <p className="muted">
        {item.targetVersion ?? 'unknown version'} · flagged {formatDateTime(item.flaggedAt)} · rubric{' '}
        <code>{item.rubricVersion.slice(0, 16)}</code>
        {item.judgeModel && ` · ${item.judgeModel}`}
      </p>
      <p>
        Judge said <strong>{item.outcome}</strong> at {formatPercent(item.confidence)} ({humanize(item.stage)})
      </p>
      {item.excerpt && (
        <div className="review-excerpt">
          <p>
            <span className="muted">Attacker:</span> {item.excerpt.attackerMessage}
          </p>
          {item.excerpt.targetResponse && (
            <p>
              <span className="muted">Co-Pilot:</span> {item.excerpt.targetResponse}
            </p>
          )}
        </div>
      )}
      {item.evidence.length > 0 && (
        <ul className="review-evidence">
          {item.evidence.map((evidence) => (
            <li key={`${evidence.kind}:${evidence.ref}`}>
              {humanize(evidence.kind)} <code>{evidence.ref}</code>
              {evidence.note && `: ${evidence.note}`}
            </li>
          ))}
        </ul>
      )}
      <div className="row-actions">
        <button
          type="button"
          aria-label={`Confirm ${item.outcome} for ${item.verdictId}`}
          disabled={mutation.isPending}
          onClick={() => mutation.mutate({ verdictId: item.verdictId, review: { decision: 'confirm' } })}
        >
          Confirm {item.outcome}
        </button>
        <OverturnForm item={item} mutation={mutation} />
      </div>
    </li>
  )
}

function resultMessage(decision: 'confirm' | 'overturn', outcome: VerdictOutcome): string {
  return decision === 'confirm' ? `Confirmed ${outcome}.` : `Overturned to ${outcome}.`
}

/** Section 8.4 escalation queue (gate G7): each decision becomes a human verdict and a ground-truth label. */
export function ReviewQueue() {
  const { data: items } = useNeedsReview()
  const mutation = useResolveReview()

  return (
    <>
      {mutation.error && (
        <p role="alert" className="form-error">
          {mutation.error.message}
        </p>
      )}
      {mutation.data && <p role="status">{resultMessage(mutation.data.decision, mutation.data.outcome)}</p>}
      {items.length === 0 && <p className="muted">No verdicts are waiting for review.</p>}
      <ol className="review-list" aria-label="Verdicts waiting for review, oldest first">
        {items.map((item) => (
          <ReviewCard key={item.verdictId} item={item} mutation={mutation} />
        ))}
      </ol>
    </>
  )
}
