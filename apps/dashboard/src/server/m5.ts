import type { ATTACK_TAXONOMY, AttackCategory, TaxonomyCell } from '@agentforge/contracts'

import { cellKey } from '../lib/coverage.js'
import type { CoverageCell, M5Summary } from '../lib/models.js'

/** Typed per category so a taxonomy key change breaks the build instead of silently shrinking M5. */
function highRisk<C extends AttackCategory>(category: C, subcategory: (typeof ATTACK_TAXONOMY)[C][number]): TaxonomyCell {
  return { category, subcategory }
}

/**
 * The M5 denominator: the six PRD cells THREAT_MODEL.md rates high risk
 * ("High-risk cells (M5 denominator)"). The misinformation high cells are
 * tracked but deliberately outside M5.
 */
export const M5_HIGH_RISK_CELLS: readonly TaxonomyCell[] = [
  highRisk('prompt_injection', 'direct'),
  highRisk('prompt_injection', 'indirect'),
  highRisk('data_exfiltration', 'authorization_bypass'),
  highRisk('denial_of_service', 'token_exhaustion'),
  highRisk('denial_of_service', 'cost_amplification'),
  highRisk('identity_role_exploitation', 'persona_hijacking'),
]

export interface M5Options {
  now: Date
  minAttempts: number
  windowDays: number
}

const DAY_MS = 86_400_000

/**
 * KEY_METRICS.md M5: a high-risk cell is covered on the current version when it
 * has at least `minAttempts` attempts and a run within `windowDays`. The
 * "variant family exercised" condition is not measured yet (coverage_snapshots
 * has no family column), and the heatmap says so.
 */
export function computeM5(cells: readonly CoverageCell[], { now, minAttempts, windowDays }: M5Options): M5Summary {
  const byKey = new Map(cells.map((cell) => [cellKey(cell), cell]))
  const highRiskKeys = M5_HIGH_RISK_CELLS.map(cellKey)
  const coveredKeys = highRiskKeys.filter((key) => {
    const cell = byKey.get(key)
    if (!cell?.lastRunAt || cell.attempts < minAttempts) {
      return false
    }
    return now.getTime() - Date.parse(cell.lastRunAt) <= windowDays * DAY_MS
  })
  return { total: highRiskKeys.length, covered: coveredKeys.length, minAttempts, windowDays, highRiskKeys, coveredKeys }
}
