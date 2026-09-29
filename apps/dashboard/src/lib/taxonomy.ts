/**
 * The PRD attack taxonomy: six categories, seventeen subcategories.
 *
 * TEMPORARY: mirrors AttackTaxonomy v1, which is landing in
 * @agentforge/contracts. When it does, re-export that constant from here and
 * delete this copy; nothing else in the dashboard names a category.
 */
export const ATTACK_TAXONOMY = {
  prompt_injection: ['direct', 'indirect', 'multi_turn'],
  data_exfiltration: ['phi_leakage', 'cross_patient', 'authorization_bypass'],
  state_corruption: ['conversation_history_manipulation', 'context_poisoning'],
  tool_misuse: ['unintended_invocation', 'parameter_tampering', 'recursive_calls'],
  denial_of_service: ['token_exhaustion', 'loops', 'cost_amplification'],
  identity_role: ['privilege_escalation', 'persona_hijacking', 'trust_boundary_violation'],
} as const satisfies Record<string, readonly string[]>
