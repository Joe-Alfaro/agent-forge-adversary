import {
  validateTaxonomyCell,
  validateVulnReport,
  type VulnReference,
  type VulnReport,
  type VulnReportHistoryEntry,
  type VulnReportStatus,
} from '@agentforge/contracts'

import type { ConfirmedExploit, DocsNarrativeModel, ReportNarrative, TokenUsage } from './types.js'

export function reportIdFor(exploitId: string): string {
  return `VR-${exploitId}`
}

export interface BuildOptions {
  model: string
  mode: 'llm' | 'offline'
  generatedAt: string
}

/**
 * Assembles a VulnReport v1 draft. Only the narrative comes from the model;
 * identity, taxonomy, OWASP mapping, reproduction steps, references, and history
 * are derived from the exploit record so they are machine-verified, not written.
 */
export function buildVulnReport(exploit: ConfirmedExploit, narrative: ReportNarrative, options: BuildOptions): VulnReport {
  const attemptId = exploit.minRepro.attempt_id
  const history: VulnReportHistoryEntry = {
    event: 'discovered',
    at: exploit.discoveredAt,
    target_version: exploit.targetVersion,
    ...(attemptId ? { attempt_id: attemptId } : {}),
  }
  return {
    schema_version: '1',
    id: reportIdFor(exploit.id),
    exploit_id: exploit.id,
    fingerprint: exploit.fingerprint,
    severity: exploit.severity,
    category: exploit.category,
    // An empty subcategory fails the schema, which is the data-quality check we want.
    subcategory: exploit.subcategory ?? '',
    owasp_ids: exploit.owaspIds,
    ...narrative,
    reproduction_steps: reproductionSteps(exploit),
    minimal_repro: { turns: exploit.minRepro.turns, ...(attemptId ? { attempt_id: attemptId } : {}) },
    status: 'draft',
    target_version: exploit.targetVersion,
    references: references(exploit),
    history: [history],
    generated_by: { agent: 'documentation', model: options.model, mode: options.mode },
    generated_at: options.generatedAt,
  }
}

function reproductionSteps(exploit: ConfirmedExploit): string[] {
  const role = exploit.sessionRole ?? 'clinician'
  const patient = exploit.contextPatientId === undefined ? '' : ` with patient ${exploit.contextPatientId} in context`
  const setup = `Open a ${role} session on ${exploit.targetVersion}${patient}.`
  const turns = exploit.minRepro.turns.map((turn, index) => `Send turn ${index + 1} verbatim: ${JSON.stringify(turn)}`)
  return [setup, ...turns, 'Compare the response with the expected behavior below.']
}

function references(exploit: ConfirmedExploit): VulnReference[] {
  const attempt: VulnReference[] = exploit.minRepro.attempt_id ? [{ kind: 'attempt', ref: exploit.minRepro.attempt_id }] : []
  const trace: VulnReference[] = exploit.traceId ? [{ kind: 'trace', ref: exploit.traceId }] : []
  const owasp = exploit.owaspIds.map((id): VulnReference => ({ kind: 'owasp', ref: id }))
  return [...attempt, ...trace, { kind: 'exploit', ref: exploit.id }, ...owasp]
}

/** Schema validation plus the taxonomy check a flat schema cannot express. Empty means the write may proceed. */
export function checkVulnReport(report: unknown): string[] {
  const schema = validateVulnReport(report)
  if (!schema.valid) {
    return schema.errors
  }
  return validateTaxonomyCell(report).errors
}

/** Raised after the retry also fails; `raw` is everything a human needs to finish the report by hand. */
export class ReportGenerationFailed extends Error {
  constructor(
    readonly exploitId: string,
    readonly errors: string[],
    readonly raw: { exploit: ConfirmedExploit; lastCandidate?: VulnReport },
  ) {
    super(`ReportGenerationFailed for ${exploitId}: ${errors.join('; ')}`)
    this.name = 'ReportGenerationFailed'
  }
}

export interface DraftOptions {
  now: () => Date
}

interface Try {
  report?: VulnReport
  errors: string[]
  usage: TokenUsage
}

async function tryDraft(exploit: ConfirmedExploit, model: DocsNarrativeModel, options: DraftOptions, feedback?: string[]): Promise<Try> {
  const noUsage = { input_tokens: 0, output_tokens: 0 }
  try {
    const result = await model.draft(feedback ? { exploit, feedback } : { exploit })
    const report = buildVulnReport(exploit, result.narrative, {
      model: result.model,
      mode: model.mode,
      generatedAt: options.now().toISOString(),
    })
    return { report, errors: checkVulnReport(report), usage: result.usage }
  } catch (error) {
    return { errors: [`model error: ${error instanceof Error ? error.message : String(error)}`], usage: noUsage }
  }
}

/**
 * Drafts a validated VulnReport. A failed validation retries once with the
 * errors fed back; a second failure throws ReportGenerationFailed (Section 4.4).
 */
export async function draftVulnReport(
  exploit: ConfirmedExploit,
  model: DocsNarrativeModel,
  options: DraftOptions,
): Promise<{ report: VulnReport; usage: TokenUsage }> {
  const first = await tryDraft(exploit, model, options)
  if (first.report && first.errors.length === 0) {
    return { report: first.report, usage: first.usage }
  }
  const second = await tryDraft(exploit, model, options, first.errors)
  const usage = {
    input_tokens: first.usage.input_tokens + second.usage.input_tokens,
    output_tokens: first.usage.output_tokens + second.usage.output_tokens,
  }
  if (second.report && second.errors.length === 0) {
    return { report: second.report, usage }
  }
  const lastCandidate = second.report ?? first.report
  throw new ReportGenerationFailed(exploit.id, second.errors, { exploit, ...(lastCandidate ? { lastCandidate } : {}) })
}

/**
 * A re-discovery updates the existing report's history rather than filing a new
 * report: same id and narrative, one more history entry, carried-forward status.
 */
export function withRediscovery(
  report: VulnReport,
  entry: VulnReportHistoryEntry,
  options: { generatedAt: string; status: VulnReportStatus },
): VulnReport {
  return {
    ...report,
    status: options.status,
    target_version: entry.target_version,
    history: [...report.history, entry],
    generated_at: options.generatedAt,
  }
}
