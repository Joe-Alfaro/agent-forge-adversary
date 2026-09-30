import type { Evidence, VerdictOutcome } from '@agentforge/contracts'

/*
 * Section 8.4 escalation: a `needs_review` verdict waits for a human (gate G7).
 * The human decision is stored as a new `stage = human` verdict on the same
 * attempt and as a ground-truth label; the Judge's own verdict is never edited.
 */

export type ReviewDecision = 'confirm' | 'overturn'

export interface TranscriptExcerpt {
  attackerMessage: string
  targetResponse?: string
}

/** A Judge verdict waiting for a human. */
export interface ReviewItem {
  verdictId: string
  attemptId: string
  /** The ticket whose family the attempt belongs to, if any; resolving the review updates it. */
  exploitId?: string
  /** `attempts.category`, shown as written even if it is outside the taxonomy. */
  category: string
  subcategory?: string
  targetVersion?: string
  outcome: VerdictOutcome
  confidence: number
  stage: string
  rubricVersion: string
  judgeModel?: string
  flaggedAt: string
  evidence: Evidence[]
  excerpt?: TranscriptExcerpt
}

export interface ReviewInput {
  decision: ReviewDecision
  /** Required to overturn: the outcome the reviewer assigns instead. */
  outcome?: VerdictOutcome
}

export interface ReviewResolution {
  verdictId: string
  decision: ReviewDecision
  /** The human verdict's outcome. */
  outcome: VerdictOutcome
  reviewer: string
  resolvedAt: string
}

export interface CategoryReviewHealth {
  category: string
  reviewed: number
  overturned: number
}

/** The Judge health panel's human-review numbers (Section 15.1). */
export interface JudgeHealth {
  backlog: number
  oldestPendingAt?: string
  reviewed: number
  overturned: number
  byCategory: CategoryReviewHealth[]
  groundTruthLabels: number
}

/** A settled review, as the fixture store keeps it for the health numbers. */
export interface ReviewRecord {
  category: string
  judged: VerdictOutcome
  human: VerdictOutcome
}

/** Human-review numbers from the pending list and the settled reviews. */
export function summarizeJudgeHealth(
  pending: readonly ReviewItem[],
  settled: readonly ReviewRecord[],
  groundTruthLabels: number,
): JudgeHealth {
  const categories = [...new Set(settled.map((record) => record.category))].sort()
  const byCategory = categories.map((category) => {
    const records = settled.filter((record) => record.category === category)
    return {
      category,
      reviewed: records.length,
      overturned: records.filter((record) => record.judged !== record.human).length,
    }
  })
  const oldest = [...pending].sort((a, b) => Date.parse(a.flaggedAt) - Date.parse(b.flaggedAt))[0]
  const health: JudgeHealth = {
    backlog: pending.length,
    reviewed: settled.length,
    overturned: settled.filter((record) => record.judged !== record.human).length,
    byCategory,
    groundTruthLabels,
  }
  return oldest ? { ...health, oldestPendingAt: oldest.flaggedAt } : health
}

const OUTCOMES: VerdictOutcome[] = ['success', 'partial', 'fail']
const EXCERPT_MAX = 600

export function isVerdictOutcome(value: unknown): value is VerdictOutcome {
  return typeof value === 'string' && OUTCOMES.some((outcome) => outcome === value)
}

export function isReviewDecision(value: unknown): value is ReviewDecision {
  return value === 'confirm' || value === 'overturn'
}

export function overturnOptions(outcome: VerdictOutcome): VerdictOutcome[] {
  return OUTCOMES.filter((candidate) => candidate !== outcome)
}

/** The human verdict's outcome for a review, or an error when an overturn changes nothing. */
export function resolvedOutcome(judged: VerdictOutcome, input: ReviewInput): VerdictOutcome {
  if (input.decision === 'confirm') {
    return judged
  }
  if (!input.outcome || input.outcome === judged) {
    throw new Error(`Overturning a ${judged} verdict must change the outcome`)
  }
  return input.outcome
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function shorten(text: string): string {
  return text.length > EXCERPT_MAX ? `${text.slice(0, EXCERPT_MAX - 1)}…` : text
}

function responseText(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined
  }
  return shorten(typeof value === 'string' ? value : JSON.stringify(value))
}

/** The last turn of an AttackTranscript v1, which is what the reviewer most needs to see. */
export function transcriptExcerpt(transcript: unknown): TranscriptExcerpt | undefined {
  const turns = isRecord(transcript) ? transcript.turns : undefined
  const last: unknown = Array.isArray(turns) ? turns.at(-1) : undefined
  if (!isRecord(last) || typeof last.attacker_message !== 'string') {
    return undefined
  }
  const excerpt: TranscriptExcerpt = { attackerMessage: shorten(last.attacker_message) }
  const targetResponse = responseText(last.target_response)
  return targetResponse === undefined ? excerpt : { ...excerpt, targetResponse }
}
