import { describe, expect, it } from 'vitest'

import {
  allowedDecisions,
  approvalGate,
  type ApprovalItem,
  autoPublishAt,
  isReportStatus,
  nextReportStatuses,
  sortApprovals,
} from '../approvals.js'

describe('approvalGate', () => {
  it('holds critical and high reports for an operator (G4)', () => {
    expect(approvalGate('critical')).toBe('G4')
    expect(approvalGate('high')).toBe('G4')
  })

  it('lets medium and low publish after the review window (G5)', () => {
    expect(approvalGate('medium')).toBe('G5')
    expect(approvalGate('low')).toBe('G5')
  })
})

describe('report status workflow', () => {
  it('moves a draft to published or rejected only', () => {
    expect(nextReportStatuses('draft')).toEqual(['published', 'rejected'])
  })

  it('lets a published report be withdrawn as a false positive (Section 10)', () => {
    expect(nextReportStatuses('published')).toEqual(['false_positive'])
  })

  it('treats rejected and false positive as final', () => {
    expect(nextReportStatuses('rejected')).toEqual([])
    expect(nextReportStatuses('false_positive')).toEqual([])
  })

  it('offers approve and reject only while the report is a draft', () => {
    expect(allowedDecisions('draft')).toEqual(['approve', 'reject'])
    expect(allowedDecisions('published')).toEqual([])
    expect(allowedDecisions('rejected')).toEqual([])
  })

  it('recognises only known statuses', () => {
    expect(isReportStatus('draft')).toBe(true)
    expect(isReportStatus('approved')).toBe(false)
    expect(isReportStatus(3)).toBe(false)
  })
})

describe('autoPublishAt', () => {
  it('is 24 hours after drafting for G5 reports', () => {
    expect(autoPublishAt('low', '2026-09-29T08:00:00.000Z')).toBe('2026-09-30T08:00:00.000Z')
  })

  it('is undefined for reports that need an operator', () => {
    expect(autoPublishAt('critical', '2026-09-29T08:00:00.000Z')).toBeUndefined()
  })
})

describe('sortApprovals', () => {
  const base: Omit<ApprovalItem, 'reportId' | 'gate' | 'draftedAt'> = {
    exploitId: 'AF-1',
    version: 1,
    severity: 'high',
    category: 'prompt_injection',
    title: 't',
    status: 'draft',
  }

  it('puts operator-gated drafts first, oldest first within a gate', () => {
    const items: ApprovalItem[] = [
      { ...base, reportId: 'g5-old', gate: 'G5', draftedAt: '2026-09-28T00:00:00Z' },
      { ...base, reportId: 'g4-new', gate: 'G4', draftedAt: '2026-09-29T00:00:00Z' },
      { ...base, reportId: 'g4-old', gate: 'G4', draftedAt: '2026-09-27T00:00:00Z' },
    ]
    expect(sortApprovals(items).map((item) => item.reportId)).toEqual(['g4-old', 'g4-new', 'g5-old'])
  })
})
