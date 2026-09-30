import { useForm } from '@tanstack/react-form'
import { useState } from 'react'

import { MAX_NIGHTLY_BUDGET_USD, parseNightlyBudget } from '../lib/budget.js'
import { formatUsd } from '../lib/format.js'
import { useUpdateNightlyBudget } from '../lib/mutations.js'

export interface BudgetControlProps {
  budgetUsd: number
}

function budgetError(value: string): string | undefined {
  try {
    parseNightlyBudget(value)
    return undefined
  } catch (error) {
    return error instanceof Error ? error.message : 'Invalid budget'
  }
}

/** The nightly budget envelope (platform_settings), editable in place (gate G3). */
export function BudgetControl({ budgetUsd }: BudgetControlProps) {
  const [editing, setEditing] = useState(false)
  const mutation = useUpdateNightlyBudget()

  const form = useForm({
    defaultValues: { budget: String(budgetUsd) },
    onSubmit: async ({ value }) => {
      await mutation.mutateAsync(parseNightlyBudget(value.budget))
      setEditing(false)
    },
  })

  if (!editing) {
    return (
      <div className="budget-control">
        <span>Nightly budget: {formatUsd(budgetUsd)}</span>
        <button
          type="button"
          aria-label="Change nightly budget"
          onClick={() => {
            mutation.reset()
            form.reset({ budget: String(budgetUsd) })
            setEditing(true)
          }}
        >
          Change
        </button>
      </div>
    )
  }

  return (
    // noValidate: the shared parseNightlyBudget rule (also enforced on the server) gives the messages.
    <form
      className="budget-control"
      aria-label="Nightly budget"
      noValidate
      onSubmit={(event) => {
        event.preventDefault()
        void form.handleSubmit()
      }}
    >
      <form.Field name="budget" validators={{ onSubmit: ({ value }) => budgetError(value) }}>
        {(field) => (
          <>
            <label>
              Nightly budget (USD)
              <input
                type="number"
                min="0.01"
                max={MAX_NIGHTLY_BUDGET_USD}
                step="0.01"
                value={field.state.value}
                onChange={(event) => field.handleChange(event.target.value)}
              />
            </label>
            {field.state.meta.errors.length > 0 && (
              <p role="alert" className="form-error">
                {field.state.meta.errors.join(' ')}
              </p>
            )}
          </>
        )}
      </form.Field>
      <button type="submit" aria-label="Save budget" disabled={mutation.isPending}>
        Save
      </button>
      <button type="button" aria-label="Cancel budget change" onClick={() => setEditing(false)}>
        Cancel
      </button>
      {mutation.error && (
        <p role="alert" className="form-error">
          {mutation.error.message}
        </p>
      )}
    </form>
  )
}
