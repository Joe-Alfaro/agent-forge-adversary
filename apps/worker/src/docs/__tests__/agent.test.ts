import { describe, expect, it } from 'vitest'

import type { VulnReport } from '@agentforge/contracts'

import { runDocumentationAgent } from '../agent.js'
import { buildVulnReport } from '../report.js'
import type { ConfirmedExploit, DocsEventRow, DocsRepository, Rediscovery, ReportRow } from '../types.js'
import { confirmedExploit, NARRATIVE, ScriptedNarrativeModel } from './fixtures.js'

const NOW = new Date('2026-09-30T05:00:00.000Z')

class InMemoryDocsRepository implements DocsRepository {
  readonly reports: ReportRow[] = []
  readonly events: DocsEventRow[] = []

  constructor(
    private readonly exploits: ConfirmedExploit[],
    private readonly rediscoveries: Rediscovery[] = [],
  ) {}

  async listUnreportedExploits() {
    return this.exploits.filter((e) => !this.reports.some((r) => r.exploitId === e.id))
  }

  async listRediscoveries() {
    return this.rediscoveries
  }

  async insertReport(row: ReportRow) {
    if (this.reports.some((r) => r.exploitId === row.exploitId && r.version >= row.version)) {
      return false
    }
    this.reports.push(row)
    return true
  }

  async recordEvent(row: DocsEventRow) {
    this.events.push(row)
  }
}

function run(repo: DocsRepository, model = new ScriptedNarrativeModel(), overrides = {}) {
  return runDocumentationAgent({ repo, model, now: () => NOW, owaspFor: () => ['LLM02'], ...overrides })
}

describe('runDocumentationAgent', () => {
  it('drafts a version-1 report for each confirmed-but-unreported exploit', async () => {
    const repo = new InMemoryDocsRepository([confirmedExploit(), confirmedExploit({ id: 'AF-2026-0008', fingerprint: 'fp-8' })])
    const summary = await run(repo)
    expect(summary.drafted).toEqual(['AF-2026-0007', 'AF-2026-0008'])
    expect(repo.reports.map((r) => [r.exploitId, r.version, r.body.status])).toEqual([
      ['AF-2026-0007', 1, 'draft'],
      ['AF-2026-0008', 1, 'draft'],
    ])
    expect(repo.events.filter((e) => e.eventType === 'report_drafted')).toHaveLength(2)
    expect(summary.costUsd).toBeGreaterThan(0)
  })

  it('is idempotent: a second pass drafts nothing', async () => {
    const repo = new InMemoryDocsRepository([confirmedExploit()])
    await run(repo)
    const second = await run(repo)
    expect(second.drafted).toEqual([])
    expect(repo.reports).toHaveLength(1)
  })

  it('falls back to the taxonomy OWASP mapping when the exploit row carries none', async () => {
    const repo = new InMemoryDocsRepository([confirmedExploit({ owaspIds: [] })])
    await run(repo)
    expect(repo.reports[0]?.body.owasp_ids).toEqual(['LLM02'])
  })

  it('records ReportGenerationFailed with the raw material and carries on', async () => {
    const bad = { ...NARRATIVE, remediation: '' }
    const repo = new InMemoryDocsRepository([confirmedExploit(), confirmedExploit({ id: 'AF-2026-0008', fingerprint: 'fp-8' })])
    const summary = await run(repo, new ScriptedNarrativeModel(bad, bad, NARRATIVE))
    expect(summary.failed.map((f) => f.exploitId)).toEqual(['AF-2026-0007'])
    expect(summary.drafted).toEqual(['AF-2026-0008'])
    const failure = repo.events.find((e) => e.eventType === 'ReportGenerationFailed')
    expect(failure?.payload).toMatchObject({ exploit_id: 'AF-2026-0007' })
    expect(JSON.stringify(failure?.payload)).toContain('fp-cross-patient-0007')
  })

  it('stops drafting at maxReports', async () => {
    const repo = new InMemoryDocsRepository([confirmedExploit(), confirmedExploit({ id: 'AF-2026-0008', fingerprint: 'fp-8' })])
    const summary = await run(repo, new ScriptedNarrativeModel(), { maxReports: 1 })
    expect(summary.drafted).toEqual(['AF-2026-0007'])
    expect(summary.deferred).toBe(1)
  })

  describe('re-discovery of an already-reported fingerprint', () => {
    const original: VulnReport = buildVulnReport(confirmedExploit(), NARRATIVE, {
      model: 'm',
      mode: 'llm',
      generatedAt: '2026-09-30T04:05:00.000Z',
    })
    const rediscovery: Rediscovery = {
      exploitId: 'AF-2026-0007',
      latestVersion: 1,
      latestStatus: 'published',
      latestBody: original,
      entry: {
        event: 'rediscovered',
        at: '2026-10-01T04:00:00.000Z',
        target_version: 'copilot@d2e3f4a',
        attempt_id: '44444444-4444-4444-8444-444444444444',
      },
    }

    it('adds a new version with the history appended, and no new report or model call', async () => {
      const model = new ScriptedNarrativeModel()
      const repo = new InMemoryDocsRepository([], [rediscovery])
      repo.reports.push({ exploitId: 'AF-2026-0007', version: 1, body: original })
      const summary = await run(repo, model)
      expect(summary.rediscovered).toEqual(['AF-2026-0007'])
      expect(model.requests).toHaveLength(0)
      expect(repo.reports).toHaveLength(2)
      const v2 = repo.reports[1]!
      expect(v2.version).toBe(2)
      expect(v2.body.id).toBe(original.id)
      expect(v2.body.status).toBe('published')
      expect(v2.body.history.map((h) => h.event)).toEqual(['discovered', 'rediscovered'])
    })

    it('ignores a re-discovery whose attempt is already in the history', async () => {
      const already = { ...rediscovery, entry: { ...rediscovery.entry, attempt_id: original.history[0]!.attempt_id! } }
      const repo = new InMemoryDocsRepository([], [already])
      const summary = await run(repo)
      expect(summary.rediscovered).toEqual([])
      expect(repo.reports).toHaveLength(0)
    })

    it('skips a re-discovery when the latest body is not a VulnReport v1', async () => {
      const legacy = { ...rediscovery, latestBody: { title: 'imported legacy body' } }
      const repo = new InMemoryDocsRepository([], [legacy])
      const summary = await run(repo)
      expect(summary.skipped).toEqual([{ exploitId: 'AF-2026-0007', reason: expect.stringContaining('VulnReport v1') }])
      expect(repo.reports).toHaveLength(0)
    })
  })
})
