import { beforeEach, describe, expect, it } from 'vitest'

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
