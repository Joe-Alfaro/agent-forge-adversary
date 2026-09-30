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

/** A confirmed exploit's stored minimal reproduction, used to replay a rerun. */
export interface ExploitReproduction {
  category: string
  subcategory?: string
  turns: string[]
}

export interface OrchestratorRepository {
  /** Upserts the target and version rows; returns the target_version id. */
  ensureTargetVersion(baseUrl: string, version: string): Promise<number>
  createNightlyRun(row: { scheduledFor: string; trigger: 'cron' | 'run_now'; plan: NightlyPlan }): Promise<number>
  /**
   * Atomically claims a `scheduled` `run_now` row (scheduled → running), oldest
   * first or a specific id, using FOR UPDATE SKIP LOCKED so two consumers never
   * grab the same row. Returns the run id and its stored `plan` jsonb (the
   * dashboard's `{ scope, requested_by, requested_at }`), or null if none.
   */
  claimRunNow(id?: number): Promise<{ nightlyRunId: number; plan: unknown } | null>
  /** Drains queued operator_requests in position order, optionally a single id. */
  drainOperatorRequests(runDate: string, singleId?: string): Promise<import('./planner.js').QueuedRequest[]>
  /** Loads an exploit's category/subcategory and its min_repro turns, for a rerun. */
  getExploitReproduction(exploitId: string): Promise<ExploitReproduction | null>
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
