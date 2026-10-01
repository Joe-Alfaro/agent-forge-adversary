/** The nightly budget envelope: default, and the operator range (platform_settings). */
export const DEFAULT_NIGHTLY_BUDGET_USD = 25
/** The operator budget range, shared with the dashboard control and the table CHECK. */
export const MAX_NIGHTLY_BUDGET_USD = 1000

/**
 * Validates an operator nightly budget: more than $0, at most $1000, rounded to
 * cents. Returns null for anything else, so a reader falls back instead of
 * planning or spending against a bad value.
 */
export function parseNightlyBudgetUsd(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0 || n > MAX_NIGHTLY_BUDGET_USD) return null
  return Math.round(n * 100) / 100
}
