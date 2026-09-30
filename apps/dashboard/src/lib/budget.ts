/*
 * The nightly budget envelope the operator sets in-app (platform_settings.
 * nightly_budget_usd, numeric(10,2)). Raising the envelope is an operator gate
 * (ARCHITECTURE.md Section 10, G3); the cap keeps a typo from authorizing a
 * runaway night.
 */

export const MAX_NIGHTLY_BUDGET_USD = 1000

/** Narrows untrusted input to a budget in dollars, rounded to cents, or throws with a message for the operator. */
export function parseNightlyBudget(value: unknown): number {
  const raw = typeof value === 'string' ? value.trim() : value
  const amount = typeof raw === 'string' && raw !== '' ? Number(raw) : raw
  if (typeof amount !== 'number' || !Number.isFinite(amount)) {
    throw new Error('The nightly budget must be a number of dollars')
  }
  const cents = Math.round(amount * 100) / 100
  if (cents <= 0) {
    throw new Error('The nightly budget must be more than $0')
  }
  if (cents > MAX_NIGHTLY_BUDGET_USD) {
    throw new Error(`The nightly budget can be at most $${MAX_NIGHTLY_BUDGET_USD}`)
  }
  return cents
}
