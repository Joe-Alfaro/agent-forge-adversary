import { beforeEach, describe, expect, it } from 'vitest'

import {
  enqueueRerun,
  fetchMorningReport,
  fetchQueue,
  fetchTicket,
  moveQueueItem,
  removeQueueItem,
  resetStore,
  updateTicket,
} from '../data-source.js'
import { buildRerunRequest } from '../queue.js'

function rerunFor(exploitId: string) {
  return buildRerunRequest({
    messageId: '6f1c2b1e-9a43-4d3b-8f1e-2a7c5d9e0b11',
    exploitId,
    requestedBy: 'operator',
    requestedFor: '2026-09-29',
  })
}

beforeEach(resetStore)

describe('updateTicket', () => {
  it('applies an allowed status change and an assignee', async () => {
    await updateTicket('AF-2026-0002', { status: 'in_progress', assignee: 'sam' })
    const ticket = await fetchTicket('AF-2026-0002')
    expect(ticket?.status).toBe('in_progress')
    expect(ticket?.assignee).toBe('sam')
  })

  it('clears the assignee when given a blank name', async () => {
    await updateTicket('AF-2026-0001', { status: 'in_progress', assignee: '  ' })
    expect((await fetchTicket('AF-2026-0001'))?.assignee).toBeUndefined()
  })

  it('rejects a transition the workflow does not allow', async () => {
    await expect(updateTicket('AF-2026-0002', { status: 'verified', assignee: '' })).rejects.toThrow(
      'open → verified',
    )
  })

  it('rejects unknown tickets', async () => {
    await expect(updateTicket('AF-0000', { status: 'open', assignee: '' })).rejects.toThrow('AF-0000')
  })
})

describe('enqueueRerun', () => {
  it('adds a rerun to the end of tonight’s queue', async () => {
    await enqueueRerun(rerunFor('AF-2026-0007'))
    const queue = await fetchQueue()
    expect(queue.items.at(-1)).toMatchObject({ kind: 'rerun', exploitId: 'AF-2026-0007', source: 'ui' })
  })

  it('refuses to queue the same ticket twice', async () => {
    await enqueueRerun(rerunFor('AF-2026-0007'))
    await expect(enqueueRerun(rerunFor('AF-2026-0007'))).rejects.toThrow('already queued')
  })

  it('refuses tickets that are resolved', async () => {
    await expect(enqueueRerun(rerunFor('AF-2026-0006'))).rejects.toThrow('verified')
  })
})

describe('queue edits', () => {
  it('removes and reorders operator requests', async () => {
    const before = (await fetchQueue()).items.map((row) => row.id)
    const [first, second] = before
    if (!first || !second) {
      throw new Error('fixture queue needs two items')
    }
    await moveQueueItem(second, 'up')
    expect((await fetchQueue()).items.map((row) => row.id).slice(0, 2)).toEqual([second, first])
    await removeQueueItem(first)
    expect((await fetchQueue()).items.map((row) => row.id)).not.toContain(first)
  })
})

describe('fetchMorningReport', () => {
  it('returns the report for a finished run and null otherwise', async () => {
    expect((await fetchMorningReport('run-2026-09-28'))?.runId).toBe('run-2026-09-28')
    expect(await fetchMorningReport('run-2026-09-29')).toBeNull()
  })
})
