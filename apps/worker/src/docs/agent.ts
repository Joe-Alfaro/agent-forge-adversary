import type { VulnReport } from '@agentforge/contracts'

import { checkVulnReport, draftVulnReport, ReportGenerationFailed, withRediscovery } from './report.js'
import type { ConfirmedExploit, DocsNarrativeModel, DocsRepository, Rediscovery, TokenUsage } from './types.js'

/** Sonnet-tier list rates, matching the executor's cost accounting (orchestrator/run.ts). */
const DEFAULT_RATE = { input: 3 / 1_000_000, output: 15 / 1_000_000 }

export interface DocumentationAgentParams {
  repo: DocsRepository
  model: DocsNarrativeModel
  now: () => Date
  /** OWASP ids for a taxonomy cell, used when the exploit row carries none (the executor writes `[]`). */
  owaspFor: (category: string, subcategory: string | null) => string[]
  /** Upper bound on new drafts per pass, to bound model spend. */
  maxReports?: number
  rate?: { input: number; output: number }
}

export interface DocumentationRunSummary {
  drafted: string[]
  rediscovered: string[]
  failed: { exploitId: string; errors: string[] }[]
  skipped: { exploitId: string; reason: string }[]
  /** Unreported exploits left for the next pass because of maxReports. */
  deferred: number
  costUsd: number
}

function traceFor(exploit: ConfirmedExploit): string {
  return exploit.traceId ?? `docs-${exploit.id}`
}

/**
 * One Documentation Agent pass (Architecture 4.4): drafts a VulnReport for
 * every confirmed-but-unreported exploit, and turns each newer confirmed hit on
 * an already-reported fingerprint into a history update (a new `reports.version`
 * with the same report id) instead of a second report. Failures are filed as
 * `ReportGenerationFailed` events and never stop the pass.
 */
export async function runDocumentationAgent(params: DocumentationAgentParams): Promise<DocumentationRunSummary> {
  const rate = params.rate ?? DEFAULT_RATE
  const summary: DocumentationRunSummary = { drafted: [], rediscovered: [], failed: [], skipped: [], deferred: 0, costUsd: 0 }
  const costOf = (usage: TokenUsage) => usage.input_tokens * rate.input + usage.output_tokens * rate.output

  const unreported = await params.repo.listUnreportedExploits()
  const limit = params.maxReports ?? unreported.length
  summary.deferred = Math.max(0, unreported.length - limit)

  // Sequential on purpose: one model call at a time keeps spend predictable.
  await unreported.slice(0, limit).reduce(async (previous, raw) => {
    await previous
    const exploit = raw.owaspIds.length > 0 ? raw : { ...raw, owaspIds: params.owaspFor(raw.category, raw.subcategory) }
    try {
      const { report, usage } = await draftVulnReport(exploit, params.model, { now: params.now })
      const cost = costOf(usage)
      summary.costUsd += cost
      const inserted = await params.repo.insertReport({ exploitId: exploit.id, version: 1, body: report })
      if (!inserted) {
        summary.skipped.push({ exploitId: exploit.id, reason: 'a report was written concurrently' })
        return
      }
      summary.drafted.push(exploit.id)
      await params.repo.recordEvent({
        traceId: traceFor(exploit),
        eventType: 'report_drafted',
        payload: {
          summary: `Drafted ${exploit.id} v1 (${report.severity}) for approval`,
          exploit_id: exploit.id,
          report_id: report.id,
          version: 1,
          model: report.generated_by.model,
          usage,
        },
        costUsd: cost,
      })
    } catch (error) {
      if (!(error instanceof ReportGenerationFailed)) {
        throw error
      }
      summary.failed.push({ exploitId: exploit.id, errors: error.errors })
      await params.repo.recordEvent({
        traceId: traceFor(exploit),
        eventType: 'ReportGenerationFailed',
        payload: { summary: `Report generation failed for ${exploit.id}`, exploit_id: exploit.id, errors: error.errors, raw: error.raw },
        costUsd: 0,
      })
    }
  }, Promise.resolve())

  const rediscoveries = await params.repo.listRediscoveries()
  await rediscoveries.reduce(async (previous, rediscovery) => {
    await previous
    await applyRediscovery(params, rediscovery, summary)
  }, Promise.resolve())

  return summary
}

async function applyRediscovery(params: DocumentationAgentParams, rediscovery: Rediscovery, summary: DocumentationRunSummary) {
  if (checkVulnReport(rediscovery.latestBody).length > 0) {
    summary.skipped.push({
      exploitId: rediscovery.exploitId,
      reason: 'the latest report body is not a VulnReport v1, so there is no history to extend',
    })
    return
  }
  const latest = rediscovery.latestBody as VulnReport
  const known = latest.history.some((h) => h.attempt_id !== undefined && h.attempt_id === rediscovery.entry.attempt_id)
  if (known) {
    return
  }
  const body = withRediscovery(latest, rediscovery.entry, {
    generatedAt: params.now().toISOString(),
    status: rediscovery.latestStatus,
  })
  const version = rediscovery.latestVersion + 1
  const inserted = await params.repo.insertReport({ exploitId: rediscovery.exploitId, version, body })
  if (!inserted) {
    return
  }
  summary.rediscovered.push(rediscovery.exploitId)
  await params.repo.recordEvent({
    traceId: `docs-${rediscovery.exploitId}`,
    eventType: 'report_history_updated',
    payload: {
      summary: `Re-discovered ${rediscovery.exploitId} on ${rediscovery.entry.target_version}; report v${version}`,
      exploit_id: rediscovery.exploitId,
      report_id: body.id,
      version,
      entry: rediscovery.entry,
    },
    costUsd: 0,
  })
}
