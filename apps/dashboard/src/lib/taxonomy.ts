/**
 * The attack taxonomy: seven categories, nineteen subcategories.
 *
 * TEMPORARY: mirrors the keys in evals/seeds/*.json on ao/agentforge/agents
 * until AttackTaxonomy v1 lands in @agentforge/contracts. When it does,
 * re-export that constant from here and delete this copy; nothing else in the
 * dashboard names a category.
 */
export const ATTACK_TAXONOMY = {
  prompt_injection: ['direct', 'indirect', 'multi-turn'],
  data_exfiltration: ['phi_leakage', 'cross_patient', 'authorization_bypass'],
  state_corruption: ['conversation_history_manipulation', 'context_poisoning'],
  tool_misuse: ['unintended_invocation', 'parameter_tampering', 'recursive_calls'],
  denial_of_service: ['token_exhaustion', 'loops', 'cost_amplification'],
  identity_role_exploitation: ['privilege_escalation', 'persona_hijacking', 'trust_boundary_violation'],
  misinformation: ['unsupported_claim', 'fabricated_citation'],
} as const satisfies Record<string, readonly string[]>
