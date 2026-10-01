import type { PriorityTerms } from '@agentforge/contracts'

/**
 * The Orchestrator's coverage-driven priority score (ARCHITECTURE 7.2). For each
 * category × subcategory cell:
 *
 *   priority = w_gap*coverage_gap + w_open*open_severity_weight
 *            + w_regress*regressed_recently + w_yield*recent_signal_per_$
 *            + w_stale*staleness - w_cost*predicted_cost
 *
 * Weights are configuration (not code) and are logged with every plan so
 * decisions can be audited. `yield` and `cost` are normalized across the
 * candidate set; `staleness` is capped so an ancient cell cannot swamp the score.
 */

export type Severity = 'critical' | 'high' | 'medium' | 'low'

export const SEVERITY_WEIGHT: Record<Severity, number> = {
  critical: 1,
  high: 0.6,
  medium: 0.3,
  low: 0.1,
}

/** Days-since-last-run cap for the staleness term (then normalized to [0,1]). */
export const STALENESS_CAP_DAYS = 30

export const DEFAULT_WEIGHTS: PriorityTerms = {
  gap: 1,
  open: 1,
  regress: 1,
  yield: 0.5,
  stale: 0.3,
  cost: 0.5,
}

export interface OpenFinding {
  severity: Severity
}

export interface CoverageCellInput {
  category: string
  subcategory: string
  attempts: number
  /** Attempts considered "sufficient" for this cell on the current version. */
  targetAttempts: number
  openFindings: OpenFinding[]
  regressedThisVersion: boolean
  /** Confirmed/partial verdicts per dollar over the trailing window (raw). */
  recentSignalPerDollar: number
  daysSinceLastRun: number
  /** Estimated dollar cost to exercise this cell (raw). */
  predictedCostUsd: number
}

export interface RankedCell extends CoverageCellInput {
  priority: number
  /** The normalized term values that produced the score, for auditing. */
  score: PriorityTerms
}

export function openSeverityWeight(findings: OpenFinding[]): number {
  return findings.reduce((sum, f) => sum + (SEVERITY_WEIGHT[f.severity] ?? 0), 0)
}

function normalize(value: number, max: number): number {
  return max <= 0 ? 0 : Math.min(1, Math.max(0, value / max))
}

/**
 * Scores and ranks candidate cells, highest priority first. Ties break
 * deterministically by category then subcategory so the ranking is a pure
 * function of the input set, independent of input order.
 */
export function rankCells(cells: CoverageCellInput[], weights: PriorityTerms): RankedCell[] {
  const maxSignal = Math.max(0, ...cells.map((c) => c.recentSignalPerDollar))
  const maxCost = Math.max(0, ...cells.map((c) => c.predictedCostUsd))

  return cells
    .map((cell): RankedCell => {
      const score: PriorityTerms = {
        gap: 1 - Math.min(cell.attempts / Math.max(cell.targetAttempts, 1), 1),
        open: openSeverityWeight(cell.openFindings),
        regress: cell.regressedThisVersion ? 1 : 0,
        yield: normalize(cell.recentSignalPerDollar, maxSignal),
        stale: normalize(Math.min(cell.daysSinceLastRun, STALENESS_CAP_DAYS), STALENESS_CAP_DAYS),
        cost: normalize(cell.predictedCostUsd, maxCost),
      }
      const priority =
        weights.gap * score.gap +
        weights.open * score.open +
        weights.regress * score.regress +
        weights.yield * score.yield +
        weights.stale * score.stale -
        weights.cost * score.cost
      return { ...cell, priority, score }
    })
    .sort(
      (a, b) =>
        b.priority - a.priority ||
        a.category.localeCompare(b.category) ||
        a.subcategory.localeCompare(b.subcategory),
    )
}
