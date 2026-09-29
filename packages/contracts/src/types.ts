export type VerdictOutcome = 'success' | 'partial' | 'fail'
export type VerdictStage = 'detector' | 'llm_primary' | 'llm_tiebreak' | 'human'
export type EvidenceKind = 'detector_hit' | 'quoted_span' | 'tool_call'

export interface Evidence {
  kind: EvidenceKind
  ref: string
  note?: string
}

export interface Verdict {
  schema_version: '1'
  message_id: string
  campaign_id: string
  trace_id: string
  attempt_id: string
  produced_by: 'judge'
  produced_at: string
  target_version: string
  outcome: VerdictOutcome
  confidence: number
  stage: VerdictStage
  judge_model?: string
  rubric_version: string
  evidence: Evidence[]
  needs_review: boolean
}

export type TargetName = 'copilot' | 'openemr'

export interface TranscriptAttachment {
  document_id: string
  doc_type: string
  seeded_via?: TargetName
}

export interface TranscriptTokenUsage {
  input_tokens: number
  output_tokens: number
}

export interface TranscriptTurnError {
  type: string
  message: string
}

export interface TranscriptTurn {
  index: number
  attacker_message: string
  attachments?: TranscriptAttachment[]
  http_status: number
  target_response?: unknown
  tool_sequence?: string[]
  degraded?: boolean
  latency_ms: number
  token_usage: TranscriptTokenUsage
  error?: TranscriptTurnError
}

export interface TranscriptTarget {
  name: TargetName
  base_url: string
  version: string
}

export interface TranscriptSession {
  id: string
  role: string
  context_patient_id?: number
}

export interface TranscriptTotals {
  turns: number
  input_tokens: number
  output_tokens: number
  latency_ms: number
}

export interface AttackTranscript {
  schema_version: '1'
  message_id: string
  campaign_id: string
  trace_id: string
  attempt_id: string
  produced_by: 'target_adapter'
  produced_at: string
  target: TranscriptTarget
  session: TranscriptSession
  turns: TranscriptTurn[]
  totals: TranscriptTotals
}

export type DetectorName = 'phi_canary' | 'cross_patient' | 'tool_call_diff' | 'scope_rule'
export type DetectorStatus = 'fired' | 'not_fired' | 'not_applicable'

export interface DetectorEvidence {
  ref: string
  span?: string
  note?: string
}

export interface DetectorEntry {
  detector: DetectorName
  status: DetectorStatus
  category: string
  authoritative?: boolean
  evidence: DetectorEvidence[]
}

export interface DetectorResult {
  schema_version: '1'
  message_id: string
  campaign_id: string
  trace_id: string
  attempt_id: string
  produced_by: 'detectors'
  produced_at: string
  target_version: string
  results: DetectorEntry[]
  any_fired: boolean
}

export interface CampaignBudget {
  tokens: number
  usd: number
}

export interface CampaignStopConditions {
  signal_per_dollar_floor?: number
  novelty_floor?: number
}

export interface CampaignPlan {
  schema_version: '1'
  message_id: string
  campaign_id: string
  trace_id: string
  produced_by: 'orchestrator'
  produced_at: string
  category: string
  subcategory?: string
  owasp_llm_ids: string[]
  owasp_ids: string[]
  seed_case_ids: string[]
  max_attempts: number
  max_turns: number
  budget: CampaignBudget
  target_version: string
  stop_conditions?: CampaignStopConditions
  mutation_strategy?: string
}

export type RerunSource = 'ui' | 'chat'

export interface RerunTarget {
  kind: 'exploit' | 'category'
  exploit_id?: string
  category?: string
}

export interface RerunRequest {
  schema_version: '1'
  message_id: string
  requested_by: string
  requested_for: string
  source: RerunSource
  reason?: string
  target: RerunTarget
}
