import type {
  Evidence,
  VulnReport,
  VulnReportHistoryEntry,
  VulnReportStatus,
  VulnSeverity,
} from '@agentforge/contracts'

/**
 * A confirmed exploit (an `exploits` row) with the material the Documentation
 * Agent needs: the minimal reproduction, the confirming verdict's evidence, and
 * what the target actually said (Architecture 4.4).
 */
export interface ConfirmedExploit {
  id: string
  fingerprint: string
  severity: VulnSeverity
  category: string
  subcategory: string | null
  owaspIds: string[]
  minRepro: { turns: string[]; attempt_id?: string }
  targetVersion: string
  discoveredAt: string
  sessionRole?: string
  contextPatientId?: number
  evidence?: Evidence[]
  traceId?: string
  /** The target's response on the confirming attempt, as untrusted data. */
  observedResponse?: string
}

/** The fields the model writes; everything else in a VulnReport is derived deterministically. */
export interface ReportNarrative {
  title: string
  summary: string
  observed_behavior: string
  expected_behavior: string
  clinical_impact: string
  remediation: string
}

export interface NarrativeRequest {
  exploit: ConfirmedExploit
  /** Validation errors from the previous try, fed back on the single retry. */
  feedback?: string[]
}

export interface TokenUsage {
  input_tokens: number
  output_tokens: number
}

export interface NarrativeResult {
  narrative: ReportNarrative
  model: string
  usage: TokenUsage
}

export interface DocsNarrativeModel {
  readonly id: string
  readonly mode: 'llm' | 'offline'
  draft(request: NarrativeRequest): Promise<NarrativeResult>
}

export interface ReportRow {
  exploitId: string
  version: number
  body: VulnReport
}

/** A newer confirmed hit on an already-reported fingerprint. */
export interface Rediscovery {
  exploitId: string
  latestVersion: number
  latestStatus: VulnReportStatus
  /** The newest `reports.body`; unknown until validated, since importers may have written other shapes. */
  latestBody: unknown
  entry: VulnReportHistoryEntry
}

export interface DocsEventRow {
  traceId: string
  eventType: 'report_drafted' | 'report_history_updated' | 'ReportGenerationFailed'
  payload: Record<string, unknown>
  costUsd: number
}

export interface DocsRepository {
  listUnreportedExploits(): Promise<ConfirmedExploit[]>
  listRediscoveries(): Promise<Rediscovery[]>
  /** Returns false when that version (or a newer one) already exists, so a concurrent pass never duplicates. */
  insertReport(row: ReportRow): Promise<boolean>
  recordEvent(row: DocsEventRow): Promise<void>
}
