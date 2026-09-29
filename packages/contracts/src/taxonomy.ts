/**
 * AttackTaxonomy v1 — the single shared taxonomy of attack categories and
 * subcategories for AgentForge. This TypeScript const is the source of truth for
 * types; `contracts/attack_taxonomy/v1.json` mirrors it as language-agnostic data
 * (a test asserts they stay in sync). Everything that keys on a category ×
 * subcategory cell — `evals/`, `coverage_snapshots`, the dashboard Coverage
 * panel, and `THREAT_MODEL.md` — must use these exact snake_case keys.
 *
 * The six categories are the PRD's minimum set; 17 cells in total.
 */
export const ATTACK_TAXONOMY = {
  prompt_injection: ['direct', 'indirect', 'multi_turn'],
  data_exfiltration: ['phi_leakage', 'cross_patient', 'authorization_bypass'],
  state_corruption: ['conversation_history_manipulation', 'context_poisoning'],
  tool_misuse: ['unintended_invocation', 'parameter_tampering', 'recursive_calls'],
  denial_of_service: ['token_exhaustion', 'loops', 'cost_amplification'],
  identity_role: ['privilege_escalation', 'persona_hijacking', 'trust_boundary_violation'],
} as const

export type AttackCategory = keyof typeof ATTACK_TAXONOMY
export type AttackSubcategory = (typeof ATTACK_TAXONOMY)[AttackCategory][number]

export const ATTACK_CATEGORIES = Object.keys(ATTACK_TAXONOMY) as AttackCategory[]

export interface TaxonomyCell {
  category: AttackCategory
  subcategory: AttackSubcategory
}

export function isAttackCategory(value: string): value is AttackCategory {
  return Object.prototype.hasOwnProperty.call(ATTACK_TAXONOMY, value)
}

/** True iff `category` is a taxonomy category and `subcategory` is one of its cells. */
export function isTaxonomyCell(category: string, subcategory: string): boolean {
  if (!isAttackCategory(category)) {
    return false
  }
  return (ATTACK_TAXONOMY[category] as readonly string[]).includes(subcategory)
}

/** Every category × subcategory cell, in declaration order (17 total). */
export function listTaxonomyCells(): TaxonomyCell[] {
  return ATTACK_CATEGORIES.flatMap((category) =>
    ATTACK_TAXONOMY[category].map((subcategory) => ({
      category,
      subcategory: subcategory as AttackSubcategory,
    })),
  )
}
