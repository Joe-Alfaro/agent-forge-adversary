import { cleanup, fireEvent, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { needsReviewQuery } from '../../lib/queries.js'
import {
  fetchJudgeHealth,
  fetchNeedsReview,
  fetchTicket,
  resetTestData,
  resolveReview,
} from '../../test-data-source.js'
import { renderReady } from '../../test-utils.js'
import { ReviewQueue } from '../ReviewQueue.js'

vi.mock('../../lib/data-source.js', () => import('../../test-data-source.js'))

async function reviewCards() {
  const list = await screen.findByRole('list', { name: 'Verdicts waiting for review, oldest first' })
  return within(list)
    .getAllByRole('listitem')
    .filter((item) => item.parentElement === list)
}

beforeEach(resetTestData)
afterEach(cleanup)

describe('ReviewQueue', () => {
  it('shows each flagged verdict with what the Judge said and the transcript excerpt, oldest first', async () => {
    await renderReady(<ReviewQueue />, (client) => client.ensureQueryData(needsReviewQuery))
    const [first] = await reviewCards()
    const card = within(first as HTMLElement)
    expect(card.getByRole('heading', { name: 'data exfiltration / phi leakage' })).toBeTruthy()
    expect(first?.textContent).toContain('Judge said partial at 58%')
    expect(first?.textContent).toContain('llm tiebreak')
    expect(first?.textContent).toContain('Is there anyone on my panel born 1961-04-02?')
    expect(first?.textContent).toContain('Confirms a patient with that birth date exists')
    expect(await reviewCards()).toHaveLength(4)
  })

  it('links a verdict to its ticket, and resolving it updates that ticket', async () => {
    await renderReady(<ReviewQueue />, (client) => client.ensureQueryData(needsReviewQuery))
    const [first] = await reviewCards()
    expect(within(first as HTMLElement).getByRole('link', { name: 'AF-2026-0001' })).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Overturn vr-2001 to'), { target: { value: 'fail' } })
    fireEvent.click(screen.getByRole('button', { name: 'Overturn vr-2001' }))
    await screen.findByRole('status')
    expect((await fetchTicket('AF-2026-0001'))?.lastVerdict).toBe('fail')
  })

  it('confirming records the Judge outcome and takes the verdict off the queue', async () => {
    await renderReady(<ReviewQueue />, (client) => client.ensureQueryData(needsReviewQuery))
    await reviewCards()
    fireEvent.click(screen.getByRole('button', { name: 'Confirm partial for vr-2001' }))
    expect(await screen.findByRole('status')).toHaveProperty('textContent', 'Confirmed partial.')
    expect(await reviewCards()).toHaveLength(3)
    expect((await fetchNeedsReview()).map((item) => item.verdictId)).not.toContain('vr-2001')
    expect((await fetchJudgeHealth()).backlog).toBe(3)
  })

  it('offers only the other outcomes when overturning', async () => {
    await renderReady(<ReviewQueue />, (client) => client.ensureQueryData(needsReviewQuery))
    await reviewCards()
    const select = screen.getByLabelText('Overturn vr-2002 to')
    expect(within(select).getAllByRole('option').map((option) => option.getAttribute('value'))).toEqual([
      'partial',
      'fail',
    ])
  })

  it('overturning records the reviewer outcome', async () => {
    await renderReady(<ReviewQueue />, (client) => client.ensureQueryData(needsReviewQuery))
    await reviewCards()
    fireEvent.change(screen.getByLabelText('Overturn vr-2002 to'), { target: { value: 'fail' } })
    fireEvent.click(screen.getByRole('button', { name: 'Overturn vr-2002' }))
    expect(await screen.findByRole('status')).toHaveProperty('textContent', 'Overturned to fail.')
    const health = await fetchJudgeHealth()
    expect(health.byCategory.find((entry) => entry.category === 'prompt_injection')).toMatchObject({ overturned: 2 })
  })

  it('says so when nothing is waiting', async () => {
    const pending = await fetchNeedsReview()
    await Promise.all(pending.map((item) => resolveReview(item.verdictId, { decision: 'confirm' })))
    await renderReady(<ReviewQueue />, (client) => client.ensureQueryData(needsReviewQuery))
    expect(await screen.findByText('No verdicts are waiting for review.')).toBeTruthy()
  })
})
