import { beforeEach, describe, expect, it } from 'vitest'

import type { AgentEvent } from '../../lib/activity.js'
import type { ReportRecord } from '../../lib/approvals.js'
import type { QueueItem } from '../../lib/models.js'
import { buildRerunRequest } from '../../lib/queue.js'
import type { TicketRow } from '../../lib/tickets.js'
import type { DashboardRepository } from '../repository.js'

/** Seed shared by the fixture and Postgres runs of the contract suite. */
export const contractTickets: TicketRow[] = [
  {
    id: 'AF-T-0001',
    severity: 'high',
    category: 'prompt_injection',
    owaspIds: ['LLM01'],
    status: 'open',
    confidence: 0,
    familySize: 4,
    discoveredVersion: 'copilot@9.0.0',
  },
  {
    id: 'AF-T-0002',
    severity: 'medium',
    category: 'data_exfiltration',
    owaspIds: ['LLM02'],
    status: 'verified',
    assignee: 'dana',
    confidence: 0,
    familySize: 1,
    discoveredVersion: 'copilot@9.0.0',
  },
  {
    id: 'AF-T-0003',
    severity: 'critical',
    category: 'data_exfiltration',
    owaspIds: ['A01'],
    status: 'regressed',
    confidence: 0,
    familySize: 2,
    discoveredVersion: 'copilot@9.0.0',
  },
]

export const contractQueue: QueueItem[] = [
  {
    id: '00000000-0000-4000-8000-000000000001',
    kind: 'focus',
    category: 'tool_misuse',
    requestedBy: 'dana',
    requestedAt: '2026-09-29T08:00:00.000Z',
    source: 'chat',
    estimatedCostUsd: 0,
  },
  {
    id: '00000000-0000-4000-8000-000000000002',
    kind: 'rerun',
    exploitId: 'AF-T-0003',
    requestedBy: 'sam',
    requestedAt: '2026-09-29T09:00:00.000Z',
    source: 'ui',
    estimatedCostUsd: 0.3,
  },
]

export const contractReportIds = {
  highDraft: '30000000-0000-4000-8000-000000000001',
  mediumDraft: '30000000-0000-4000-8000-000000000002',
  criticalPublished: '30000000-0000-4000-8000-000000000003',
  criticalRedraft: '30000000-0000-4000-8000-000000000004',
} as const

/** AF-T-0003 has a published v1 and a newer v2 draft; only the draft waits for approval. */
export const contractReports: ReportRecord[] = [
  {
    id: contractReportIds.highDraft,
    exploitId: 'AF-T-0001',
    version: 1,
    status: 'draft',
    title: 'System prompt override through a pasted note',
    createdAt: '2026-09-29T06:00:00.000Z',
  },
  {
    id: contractReportIds.mediumDraft,
    exploitId: 'AF-T-0002',
    version: 1,
    status: 'draft',
    title: 'Partial MRN echoed back',
    createdAt: '2026-09-29T05:00:00.000Z',
  },
  {
    id: contractReportIds.criticalPublished,
    exploitId: 'AF-T-0003',
    version: 1,
    status: 'published',
    title: 'Cross-patient summary',
    createdAt: '2026-09-20T05:00:00.000Z',
    approvedBy: 'dana',
    publishedAt: '2026-09-20T09:00:00.000Z',
  },
  {
    id: contractReportIds.criticalRedraft,
    exploitId: 'AF-T-0003',
    version: 2,
    status: 'draft',
    title: 'Cross-patient summary (regressed)',
    createdAt: '2026-09-29T07:00:00.000Z',
  },
]

/** Out of order on purpose: the feed sorts newest first. */
export const contractEvents: AgentEvent[] = [
  {
    id: '1',
    traceId: 'trace-a',
    agent: 'orchestrator',
    eventType: 'plan_created',
    costUsd: 0.02,
    createdAt: '2026-09-29T06:00:00.000Z',
    traceUrl: 'https://langfuse.test/trace/trace-a',
    summary: 'Planned 2 campaigns',
  },
  {
    id: '3',
    traceId: 'trace-a',
    agent: 'judge',
    eventType: 'verdict',
    costUsd: 0.11,
    createdAt: '2026-09-29T06:20:00.000Z',
  },
  {
    id: '2',
    traceId: 'trace-a',
    agent: 'redteam',
    eventType: 'attempt',
    costUsd: 0.05,
    createdAt: '2026-09-29T06:10:00.000Z',
    source: 'run_import',
  },
]

/** Clock for the suite: 2026-09-29 15:00 CDT, so tonight's run date is 2026-09-30. */
export const contractNow = new Date('2026-09-29T20:00:00Z')
export const contractRunDate = '2026-09-30'

export interface ContractOptions {
  /** Creates a repository over a freshly seeded store. */
  setup: () => Promise<DashboardRepository>
}

function rerun(exploitId: string, messageId = '11111111-1111-4111-8111-111111111111') {
  return buildRerunRequest({ messageId, exploitId, requestedBy: 'operator', requestedFor: contractRunDate })
}

export function describeRepositoryContract(name: string, options: ContractOptions) {
  describe(`${name} repository contract`, () => {
    let repo: DashboardRepository

    beforeEach(async () => {
      repo = await options.setup()
    })

    describe('tickets', () => {
      it('lists every seeded ticket with its workflow fields', async () => {
        const tickets = await repo.listTickets()
        expect(tickets.map((ticket) => ticket.id).sort()).toEqual(['AF-T-0001', 'AF-T-0002', 'AF-T-0003'])
        expect(tickets.find((ticket) => ticket.id === 'AF-T-0002')).toMatchObject({
          status: 'verified',
          assignee: 'dana',
          familySize: 1,
          owaspIds: ['LLM02'],
          discoveredVersion: 'copilot@9.0.0',
        })
      })

      it('returns null for an unknown ticket', async () => {
        expect(await repo.getTicket('AF-NOPE')).toBeNull()
      })

      it('persists an allowed status change and assignee', async () => {
        await repo.updateTicket('AF-T-0001', { status: 'in_progress', assignee: ' sam ' })
        expect(await repo.getTicket('AF-T-0001')).toMatchObject({ status: 'in_progress', assignee: 'sam' })
      })

      it('clears the assignee when given a blank name', async () => {
        await repo.updateTicket('AF-T-0002', { status: 'verified', assignee: '  ' })
        expect((await repo.getTicket('AF-T-0002'))?.assignee).toBeUndefined()
      })

      it('rejects transitions the workflow does not allow and leaves the ticket alone', async () => {
        await expect(repo.updateTicket('AF-T-0001', { status: 'verified', assignee: '' })).rejects.toThrow(
          'open → verified',
        )
        expect((await repo.getTicket('AF-T-0001'))?.status).toBe('open')
      })

      it('rejects unknown tickets', async () => {
        await expect(repo.updateTicket('AF-NOPE', { status: 'open', assignee: '' })).rejects.toThrow('AF-NOPE')
      })
    })

    describe('agent activity', () => {
      it('lists events newest first with trace linkage', async () => {
        const events = await repo.listAgentEvents(10)
        expect(events.map((event) => event.id)).toEqual(['3', '2', '1'])
        expect(events[2]).toEqual(contractEvents[0])
        expect(events[1]).toMatchObject({ agent: 'redteam', source: 'run_import', costUsd: 0.05 })
        expect(events[0]?.traceUrl).toBeUndefined()
      })

      it('returns at most `limit` events', async () => {
        expect((await repo.listAgentEvents(2)).map((event) => event.id)).toEqual(['3', '2'])
      })
    })

    describe('approvals', () => {
      it('lists the latest draft per exploit, operator-gated first and oldest first', async () => {
        const items = await repo.listApprovals()
        expect(items.map((item) => [item.reportId, item.gate])).toEqual([
          [contractReportIds.highDraft, 'G4'],
          [contractReportIds.criticalRedraft, 'G4'],
          [contractReportIds.mediumDraft, 'G5'],
        ])
        expect(items[1]).toMatchObject({
          exploitId: 'AF-T-0003',
          version: 2,
          severity: 'critical',
          category: 'data_exfiltration',
          title: 'Cross-patient summary (regressed)',
          status: 'draft',
          draftedAt: '2026-09-29T07:00:00.000Z',
        })
        expect(items[1]?.autoPublishAt).toBeUndefined()
        expect(items[2]?.autoPublishAt).toBe('2026-09-30T05:00:00.000Z')
      })

      it('approving publishes the report and records the approver', async () => {
        const decided = await repo.decideApproval(contractReportIds.highDraft, 'approve', 'operator')
        expect(decided).toMatchObject({ status: 'published', approvedBy: 'operator', publishedAt: contractNow.toISOString() })
        const remaining = await repo.listApprovals()
        expect(remaining.map((item) => item.reportId)).not.toContain(contractReportIds.highDraft)
      })

      it('rejecting records the reviewer and does not publish', async () => {
        const decided = await repo.decideApproval(contractReportIds.mediumDraft, 'reject', 'operator')
        expect(decided).toMatchObject({ status: 'rejected', approvedBy: 'operator' })
        expect(decided.publishedAt).toBeUndefined()
        expect((await repo.listApprovals()).map((item) => item.reportId)).not.toContain(contractReportIds.mediumDraft)
      })

      it('refuses decisions on reports that are not drafts, and unknown reports', async () => {
        await expect(repo.decideApproval(contractReportIds.criticalPublished, 'approve', 'operator')).rejects.toThrow(
          'published → published',
        )
        await expect(
          repo.decideApproval('30000000-0000-4000-8000-00000000ffff', 'approve', 'operator'),
        ).rejects.toThrow('Unknown report')
        await expect(repo.decideApproval('not-a-uuid', 'reject', 'operator')).rejects.toThrow('Unknown report')
      })

      it('refuses a decision twice', async () => {
        await repo.decideApproval(contractReportIds.highDraft, 'reject', 'operator')
        await expect(repo.decideApproval(contractReportIds.highDraft, 'approve', 'operator')).rejects.toThrow(
          'rejected → published',
        )
      })
    })

    describe('tonight’s queue', () => {
      it('reads queued requests in order with tonight’s run date and envelope', async () => {
        const queue = await repo.getQueue()
        expect(queue.runDate).toBe(contractRunDate)
        expect(queue.envelopeUsd).toBe(25)
        expect(queue.items.map((item) => item.id)).toEqual(contractQueue.map((item) => item.id))
        expect(queue.items[1]).toMatchObject({ kind: 'rerun', exploitId: 'AF-T-0003', estimatedCostUsd: 0.3 })
      })

      it('appends a valid RerunRequest and keeps the operator’s reason', async () => {
        const request = { ...rerun('AF-T-0001'), reason: 'focus on exfiltration' }
        const queue = await repo.enqueueRerun(request)
        expect(queue.items.at(-1)).toMatchObject({
          id: request.message_id,
          kind: 'rerun',
          exploitId: 'AF-T-0001',
          source: 'ui',
          requestedBy: 'operator',
          reason: 'focus on exfiltration',
          estimatedCostUsd: 0.6,
        })
        expect((await repo.getQueue()).items).toHaveLength(3)
      })

      it('rejects requests that fail the RerunRequest v1 schema', async () => {
        const invalid = { ...rerun('AF-T-0001'), message_id: 'not-a-uuid' }
        await expect(repo.enqueueRerun(invalid)).rejects.toThrow('Invalid RerunRequest')
      })

      it('refuses duplicates and resolved tickets', async () => {
        await expect(repo.enqueueRerun(rerun('AF-T-0003'))).rejects.toThrow('already queued')
        await expect(repo.enqueueRerun(rerun('AF-T-0002'))).rejects.toThrow('verified')
      })

      it('removes a request from tonight’s queue', async () => {
        const [first] = contractQueue
        if (!first) {
          throw new Error('seed needs a queue item')
        }
        const queue = await repo.removeQueueItem(first.id)
        expect(queue.items.map((item) => item.id)).not.toContain(first.id)
        expect((await repo.getQueue()).items).toHaveLength(1)
      })

      it('persists a reorder, and new requests join the end', async () => {
        const [first, second] = contractQueue
        if (!first || !second) {
          throw new Error('seed needs two queue items')
        }
        await repo.moveQueueItem(second.id, 'up')
        expect((await repo.getQueue()).items.map((item) => item.id)).toEqual([second.id, first.id])
        const enqueued = await repo.enqueueRerun(rerun('AF-T-0001'))
        expect(enqueued.items.map((item) => item.id)).toEqual([second.id, first.id, rerun('AF-T-0001').message_id])
      })
    })
  })
}
