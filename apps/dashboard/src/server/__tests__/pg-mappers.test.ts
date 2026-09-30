// @vitest-environment node
import { describe, expect, it } from 'vitest'

import { mapApprovalRow, mapMorningReport, mapQueueItem, mapRunSummary, mapTicket } from '../pg-mappers.js'

describe('mapTicket', () => {
  const row = {
    id: 'AF-2026-0001',
    severity: 'critical',
    category: 'data_exfiltration',
    owasp_ids: ['LLM02'],
    status: 'open',
    assignee: null,
    family_size: 3,
    max_confidence: '0.970',
    last_verdict: 'success',
    discovered_version: 'copilot@1.4.0',
    last_verified_version: null,
  }

  it('converts Postgres types and drops nulls', () => {
    expect(mapTicket(row)).toEqual({
      id: 'AF-2026-0001',
      severity: 'critical',
      category: 'data_exfiltration',
      owaspIds: ['LLM02'],
      status: 'open',
      confidence: 0.97,
      familySize: 3,
      lastVerdict: 'success',
      discoveredVersion: 'copilot@1.4.0',
    })
  })

  it('treats a missing confidence as zero and keeps optional fields when present', () => {
    expect(mapTicket({ ...row, max_confidence: null, assignee: 'dana', last_verified_version: 'copilot@1.4.1' })).toMatchObject({
      confidence: 0,
      assignee: 'dana',
      lastVerifiedVersion: 'copilot@1.4.1',
    })
  })

  it('rejects rows that break the ticket contract', () => {
    expect(() => mapTicket({ ...row, severity: 'catastrophic' })).toThrow('severity')
    expect(() => mapTicket({ ...row, status: 'wontfix' })).toThrow('status')
  })
})

const runRow = {
  id: 12,
  trigger: 'cron',
  status: 'completed',
  started_at: new Date('2026-09-30T06:00:00Z'),
  finished_at: new Date('2026-09-30T08:30:00Z'),
  spend_usd: '41.2500',
  // NightlyRunSummary v1; extra keys are allowed by the contract.
  summary: {
    target_version: 'copilot@1.4.1',
    headline: 'Quiet night',
    new_tickets: ['AF-2026-0009'],
    regressions: ['AF-2026-0004'],
    verified_fixes: [],
    queue: { ran: 3, cut: 1, skipped: 0 },
    notes: ['n1'],
    trace_url: 'https://t/12',
    generated_at: '2026-09-30T08:35:00Z',
    spend_breakdown: { judge: 4 },
  },
  attempts: '900',
  success: '4',
  partial: '10',
  fail: '886',
  target_version: 'copilot@1.4.1',
  new_tickets_by_time: '3',
}

describe('mapRunSummary', () => {
  it('prefers summary counts and links over derived ones', () => {
    expect(mapRunSummary(runRow)).toEqual({
      id: '12',
      trigger: 'cron',
      status: 'completed',
      startedAt: '2026-09-30T06:00:00.000Z',
      finishedAt: '2026-09-30T08:30:00.000Z',
      targetVersion: 'copilot@1.4.1',
      attempts: 900,
      verdicts: { success: 4, partial: 10, fail: 886 },
      newTickets: 1,
      regressions: 1,
      spendUsd: 41.25,
      hasMorningReport: true,
      traceUrl: 'https://t/12',
    })
  })

  it('falls back to derived counts when the run has no summary yet', () => {
    const mapped = mapRunSummary({ ...runRow, status: 'running', finished_at: null, summary: null, target_version: null })
    expect(mapped).toMatchObject({ newTickets: 3, regressions: 0, hasMorningReport: false, targetVersion: 'unknown' })
    expect(mapped).not.toHaveProperty('finishedAt')
    expect(mapped).not.toHaveProperty('traceUrl')
  })

  it('ignores a summary that fails NightlyRunSummary v1 instead of trusting it', () => {
    const mapped = mapRunSummary({ ...runRow, summary: { headline: 'partial write', new_tickets: 'AF-1' } })
    expect(mapped).toMatchObject({ newTickets: 3, regressions: 0, hasMorningReport: false })
    expect(mapped).not.toHaveProperty('traceUrl')
  })

  it('maps unknown run statuses to failed rather than crashing the table', () => {
    expect(mapRunSummary({ ...runRow, status: 'exploded' }).status).toBe('failed')
  })
})

describe('mapMorningReport', () => {
  it('builds the report from a finished run with a summary', () => {
    expect(mapMorningReport(runRow)).toMatchObject({
      runId: '12',
      targetVersion: 'copilot@1.4.1',
      generatedAt: '2026-09-30T08:35:00Z',
      headline: 'Quiet night',
      queue: { ran: 3, cut: 1 },
      notes: ['n1'],
      newTickets: ['AF-2026-0009'],
      regressions: ['AF-2026-0004'],
      spendUsd: 41.25,
    })
  })

  it('has no report until the run has a summary', () => {
    expect(mapMorningReport({ ...runRow, summary: null })).toBeNull()
  })
})

describe('mapQueueItem', () => {
  const queueRow = {
    id: '6f1c2b1e-9a43-4d3b-8f1e-2a7c5d9e0b11',
    kind: 'rerun',
    exploit_id: 'AF-2026-0007',
    category: null,
    requested_by: 'operator',
    source: 'ui',
    reason: null,
    created_at: new Date('2026-09-29T10:00:00Z'),
    family_size: 4,
    estimated_cost_usd: null,
  }

  it('estimates rerun cost from the family size', () => {
    expect(mapQueueItem(queueRow)).toEqual({
      id: '6f1c2b1e-9a43-4d3b-8f1e-2a7c5d9e0b11',
      kind: 'rerun',
      exploitId: 'AF-2026-0007',
      requestedBy: 'operator',
      requestedAt: '2026-09-29T10:00:00.000Z',
      source: 'ui',
      estimatedCostUsd: 0.6,
    })
  })

  it('prefers the stored estimate when the request has one', () => {
    expect(mapQueueItem({ ...queueRow, estimated_cost_usd: '2.5000' }).estimatedCostUsd).toBe(2.5)
    expect(mapQueueItem({ ...queueRow, kind: 'focus', family_size: null, estimated_cost_usd: '12' }).estimatedCostUsd).toBe(12)
  })

  it('does not estimate campaigns the Orchestrator sizes itself', () => {
    expect(
      mapQueueItem({ ...queueRow, kind: 'focus', exploit_id: null, category: 'tool_misuse', family_size: null }),
    ).toMatchObject({ kind: 'focus', category: 'tool_misuse', estimatedCostUsd: 0 })
  })
})

describe('mapApprovalRow', () => {
  const row = {
    id: 'r-1',
    exploit_id: 'AF-1',
    version: 2,
    status: 'draft',
    title: 'Leak',
    severity: 'medium',
    category: 'data_exfiltration',
    approved_by: null,
    published_at: null,
    created_at: new Date('2026-09-29T05:00:00Z'),
  }

  it('maps a draft with its gate and auto-publish time', () => {
    expect(mapApprovalRow(row)).toEqual({
      reportId: 'r-1',
      exploitId: 'AF-1',
      version: 2,
      severity: 'medium',
      category: 'data_exfiltration',
      title: 'Leak',
      status: 'draft',
      draftedAt: '2026-09-29T05:00:00.000Z',
      gate: 'G5',
      autoPublishAt: '2026-09-30T05:00:00.000Z',
    })
  })

  it('falls back to the exploit and version when the body has no title', () => {
    expect(mapApprovalRow({ ...row, title: null }).title).toBe('AF-1 report v2')
  })

  it('rejects statuses outside the report workflow', () => {
    expect(() => mapApprovalRow({ ...row, status: 'approved' })).toThrow('unknown status "approved"')
  })
})
