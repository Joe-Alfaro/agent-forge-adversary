import type {
  AttackTranscript,
  NightlyPlan,
  NightlyPlanItem,
  NightlyRunSummary,
  Verdict,
} from '@agentforge/contracts'

/**
 * The persistence seam for the Orchestrator RUN executor. Keeping it behind an
 * interface lets the whole run pipeline be tested offline against an in-memory
 * fake, while the real Postgres implementation (pgRepository.ts) is exercised
 * only by the gated integration test and the Run-now entrypoint.
 */

export interface AttemptRow {
  campaignId: string
  parentAttemptId?: string | null
  fingerprint: string
  category: string
  subcategory?: string
  owaspIds: string[]
  techniqueTags: string[]
  transcript: AttackTranscript
  targetVersionId: number
  tokens: number
  costUsd: number
}

export interface VerdictRow {
  attemptId: string
  verdict: Verdict
}

export interface ExploitRow {
  fingerprint: string
  severity: string
  category: string
  subcategory?: string
  owaspIds: string[]
  minRepro: unknown
  discoveredVersionId: number
  familyIds: string[]
}

export interface CoverageSnapshotRow {
  targetVersionId: number
  category: string
  subcategory: string
  attempts: number
  confirmed: number
  familiesExercised: number
  lastRunAt: string
}

export interface OrchestratorRepository {
  /** Upserts the target and version rows; returns the target_version id. */
  ensureTargetVersion(baseUrl: string, version: string): Promise<number>
  createNightlyRun(row: { scheduledFor: string; trigger: 'cron' | 'run_now'; plan: NightlyPlan }): Promise<number>
  createCampaign(row: { nightlyRunId: number; plan: NightlyPlanItem; budgetUsd: number }): Promise<string>
  insertAttempt(row: AttemptRow): Promise<string>
  insertVerdict(row: VerdictRow): Promise<void>
  /** Upserts by fingerprint; returns the (possibly newly minted) exploit id and whether it was new. */
  upsertExploit(row: ExploitRow): Promise<{ id: string; isNew: boolean }>
  upsertCoverageSnapshot(row: CoverageSnapshotRow): Promise<void>
  updateCampaign(id: string, args: { spendUsd: number; status: string }): Promise<void>
  finishNightlyRun(id: number, args: { summary: NightlyRunSummary; spendUsd: number; status: string }): Promise<void>
  setRequestStatus(id: string, status: 'ran' | 'cut', nightlyRunId: number): Promise<void>
}
