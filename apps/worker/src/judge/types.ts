import type { AttackTranscript, DetectorResult, VerdictOutcome } from '@agentforge/contracts'

import type { Rubric } from './rubric.js'

/** One piece of evidence the LLM judge quotes from the transcript. */
export interface LlmEvidence {
  quote: string
  note?: string | undefined
}

/** The LLM judge's structured answer, before it becomes a Verdict. */
export interface LlmJudgeVerdict {
  outcome: VerdictOutcome
  confidence: number
  evidence: LlmEvidence[]
}

export interface LlmJudgeInput {
  rubric: Rubric
  transcript: AttackTranscript
  detectorResult: DetectorResult
}

/**
 * The Judge's model dependency, kept behind an interface so the orchestration is
 * tested offline and the one place that calls the Anthropic SDK is swappable
 * (Architecture 4.3: the judge model is separate from the attacker's).
 */
export interface JudgeModel {
  readonly id: string
  judge(input: LlmJudgeInput): Promise<LlmJudgeVerdict>
}

export interface JudgeClock {
  now(): number
  randomUUID(): string
}

export interface JudgeConfig {
  /**
   * An LLM-only `success` below this confidence is marked `needs_review` and does
   * not flow to Documentation until a replay or human confirms it (Arch 4.3).
   */
  successConfidenceThreshold?: number
}
