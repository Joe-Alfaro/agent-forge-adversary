import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import type { AgentEvent } from '../../lib/activity.js'
import { ActivityFeed } from '../ActivityFeed.js'

const events: AgentEvent[] = [
  {
    id: '3',
    traceId: 'run-b',
    agent: 'judge',
    eventType: 'verdict_batch',
    costUsd: 2.2,
    createdAt: '2026-09-29T14:52:00Z',
    summary: '6 success',
  },
  {
    id: '2',
    traceId: 'run-a',
    agent: 'judge',
    eventType: 'verdict_batch',
    costUsd: 6.3,
    createdAt: '2026-09-28T08:40:00Z',
    traceUrl: 'https://langfuse.example/trace/run-a',
  },
  {
    id: '1',
    traceId: 'run-a',
    agent: 'orchestrator',
    eventType: 'plan_created',
    costUsd: 0.04,
    createdAt: '2026-09-28T07:00:40Z',
    traceUrl: 'https://langfuse.example/trace/run-a',
  },
]

function items() {
  return within(screen.getByRole('list', { name: 'Agent activity, newest first' })).queryAllByRole('listitem')
}

afterEach(cleanup)

describe('ActivityFeed', () => {
  it('shows each event with its agent, type, cost, time, and summary, in the order given', () => {
    render(<ActivityFeed events={events} />)
    const [first] = items()
    expect(items()).toHaveLength(3)
    expect(first?.textContent).toContain('judge')
    expect(first?.textContent).toContain('verdict batch')
    expect(first?.textContent).toContain('$2.20')
    expect(first?.textContent).toContain('2026-09-29 14:52 UTC')
    expect(first?.textContent).toContain('6 success')
  })

  it('links out to the Langfuse trace only when the event has one', () => {
    render(<ActivityFeed events={events} />)
    const [first, second] = items()
    expect(within(first as HTMLElement).queryByRole('link', { name: /Langfuse/ })).toBeNull()
    const link = within(second as HTMLElement).getByRole('link', { name: 'Open trace run-a in Langfuse' })
    expect(link.getAttribute('href')).toBe('https://langfuse.example/trace/run-a')
    expect(link.getAttribute('target')).toBe('_blank')
    expect(link.getAttribute('rel')).toContain('noreferrer')
  })

  it('filters by agent', () => {
    render(<ActivityFeed events={events} />)
    fireEvent.change(screen.getByLabelText('Agent'), { target: { value: 'orchestrator' } })
    expect(items().map((item) => item.getAttribute('data-event-id'))).toEqual(['1'])
  })

  it('follows one trace, and goes back to all', () => {
    render(<ActivityFeed events={events} />)
    fireEvent.click(within(items()[1] as HTMLElement).getByRole('button', { name: 'Only trace run-a' }))
    expect(items().map((item) => item.getAttribute('data-event-id'))).toEqual(['2', '1'])
    fireEvent.click(screen.getByRole('button', { name: 'Show all traces' }))
    expect(items()).toHaveLength(3)
  })

  it('says so when there is no activity', () => {
    render(<ActivityFeed events={[]} />)
    expect(screen.getByText('No agent activity recorded yet.')).toBeTruthy()
  })
})
