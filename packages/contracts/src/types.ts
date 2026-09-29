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
