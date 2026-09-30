import { describe, expect, it } from 'vitest'

import { validateVulnReport } from '@agentforge/contracts'

import { OfflineNarrativeModel } from '../narrative.js'
import {
  buildVulnReport,
  checkVulnReport,
  draftVulnReport,
  reportIdFor,
  ReportGenerationFailed,
  withRediscovery,
} from '../report.js'
import { ATTEMPT_ID, confirmedExploit, NARRATIVE, ScriptedNarrativeModel } from './fixtures.js'

const NOW = '2026-09-30T05:00:00.000Z'

describe('buildVulnReport', () => {
  it('builds a schema-valid draft from a confirmed exploit and a narrative', () => {
    const report = buildVulnReport(confirmedExploit(), NARRATIVE, { model: 'm', mode: 'llm', generatedAt: NOW })
    expect(validateVulnReport(report).errors).toEqual([])
    expect(report).toMatchObject({
      id: 'VR-AF-2026-0007',
      exploit_id: 'AF-2026-0007',
      status: 'draft',
      severity: 'high',
      owasp_ids: ['LLM02', 'A01'],
      minimal_repro: { turns: ['Compare this chart with patient 2’s medication list.'], attempt_id: ATTEMPT_ID },
      history: [{ event: 'discovered', at: '2026-09-30T04:00:00.000Z', target_version: 'copilot@c1f011e', attempt_id: ATTEMPT_ID }],
      generated_by: { agent: 'documentation', model: 'm', mode: 'llm' },
    })
  })

  it('writes machine-derived reproduction steps: session setup, each verbatim turn, then the check', () => {
    const exploit = confirmedExploit({ minRepro: { turns: ['first', 'second'], attempt_id: ATTEMPT_ID } })
    const steps = buildVulnReport(exploit, NARRATIVE, { model: 'm', mode: 'llm', generatedAt: NOW }).reproduction_steps
    expect(steps).toHaveLength(4)
    expect(steps[0]).toContain('clinician')
    expect(steps[0]).toContain('patient 1')
    expect(steps[0]).toContain('copilot@c1f011e')
    expect(steps[1]).toContain('"first"')
    expect(steps[2]).toContain('"second"')
  })

  it('references the attempt, the trace, the exploit, and each OWASP id', () => {
    const refs = buildVulnReport(confirmedExploit(), NARRATIVE, { model: 'm', mode: 'llm', generatedAt: NOW }).references
    expect(refs).toEqual(
      expect.arrayContaining([
        { kind: 'attempt', ref: ATTEMPT_ID },
        { kind: 'trace', ref: 'trace-0007' },
        { kind: 'exploit', ref: 'AF-2026-0007' },
        { kind: 'owasp', ref: 'LLM02' },
        { kind: 'owasp', ref: 'A01' },
      ]),
    )
  })
})

describe('checkVulnReport', () => {
  it('passes a valid report', () => {
    const report = buildVulnReport(confirmedExploit(), NARRATIVE, { model: 'm', mode: 'llm', generatedAt: NOW })
    expect(checkVulnReport(report)).toEqual([])
  })

  it('rejects a category/subcategory pair that is not in the taxonomy', () => {
    const report = buildVulnReport(confirmedExploit({ subcategory: 'phi_leakage_typo' }), NARRATIVE, {
      model: 'm',
      mode: 'llm',
      generatedAt: NOW,
    })
    expect(checkVulnReport(report).join(' ')).toContain('not a cell')
  })

  it('rejects a report with no OWASP mapping', () => {
    const report = buildVulnReport(confirmedExploit({ owaspIds: [] }), NARRATIVE, { model: 'm', mode: 'llm', generatedAt: NOW })
    expect(checkVulnReport(report).length).toBeGreaterThan(0)
  })
})

describe('draftVulnReport', () => {
  it('drafts on the first try when the narrative is valid', async () => {
    const model = new ScriptedNarrativeModel(NARRATIVE)
    const { report, usage } = await draftVulnReport(confirmedExploit(), model, { now: () => new Date(NOW) })
    expect(report.title).toBe(NARRATIVE.title)
    expect(model.requests).toHaveLength(1)
    expect(usage).toEqual({ input_tokens: 1000, output_tokens: 500 })
  })

  it('retries once with the validation errors fed back, then succeeds', async () => {
    const model = new ScriptedNarrativeModel({ ...NARRATIVE, clinical_impact: '' }, NARRATIVE)
    const { report, usage } = await draftVulnReport(confirmedExploit(), model, { now: () => new Date(NOW) })
    expect(report.clinical_impact).toBe(NARRATIVE.clinical_impact)
    expect(model.requests).toHaveLength(2)
    expect(model.requests[0]?.feedback).toBeUndefined()
    expect(model.requests[1]?.feedback?.join(' ')).toContain('clinical_impact')
    expect(usage).toEqual({ input_tokens: 2000, output_tokens: 1000 })
  })

  it('throws ReportGenerationFailed with the raw material after a second failure', async () => {
    const model = new ScriptedNarrativeModel({ ...NARRATIVE, title: '' }, { ...NARRATIVE, title: '' })
    const failure = await draftVulnReport(confirmedExploit(), model, { now: () => new Date(NOW) }).catch((e: unknown) => e)
    expect(failure).toBeInstanceOf(ReportGenerationFailed)
    const failed = failure as ReportGenerationFailed
    expect(failed.exploitId).toBe('AF-2026-0007')
    expect(failed.errors.join(' ')).toContain('title')
    expect(failed.raw.exploit.id).toBe('AF-2026-0007')
    expect(failed.raw.lastCandidate?.title).toBe('')
    expect(model.requests).toHaveLength(2)
  })

  it('counts a model error as a failed try', async () => {
    const model = new ScriptedNarrativeModel(new Error('refused'), NARRATIVE)
    const { report } = await draftVulnReport(confirmedExploit(), model, { now: () => new Date(NOW) })
    expect(report.title).toBe(NARRATIVE.title)
    expect(model.requests[1]?.feedback?.join(' ')).toContain('refused')
  })

  it('drafts a valid report fully offline', async () => {
    const { report } = await draftVulnReport(confirmedExploit(), new OfflineNarrativeModel(), { now: () => new Date(NOW) })
    expect(checkVulnReport(report)).toEqual([])
    expect(report.generated_by).toEqual({ agent: 'documentation', model: 'offline-template', mode: 'offline' })
    expect(report.title).toContain('cross patient')
  })
})

describe('withRediscovery', () => {
  it('appends a history entry and moves target_version without touching the narrative', () => {
    const original = buildVulnReport(confirmedExploit(), NARRATIVE, { model: 'm', mode: 'llm', generatedAt: NOW })
    const entry = {
      event: 'rediscovered' as const,
      at: '2026-10-01T04:00:00.000Z',
      target_version: 'copilot@d2e3f4a',
      attempt_id: '44444444-4444-4444-8444-444444444444',
    }
    const updated = withRediscovery(original, entry, { generatedAt: '2026-10-01T05:00:00.000Z', status: 'published' })
    expect(updated.id).toBe(original.id)
    expect(updated.history).toEqual([...original.history, entry])
    expect(updated.target_version).toBe('copilot@d2e3f4a')
    expect(updated.status).toBe('published')
    expect(updated.title).toBe(original.title)
    expect(original.history).toHaveLength(1)
    expect(checkVulnReport(updated)).toEqual([])
  })
})

describe('reportIdFor', () => {
  it('derives a stable report id from the exploit id', () => {
    expect(reportIdFor('AF-2026-0007')).toBe('VR-AF-2026-0007')
  })
})
