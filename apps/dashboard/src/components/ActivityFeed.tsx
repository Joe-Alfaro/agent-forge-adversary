import { useState } from 'react'

import type { AgentEvent } from '../lib/activity.js'
import { formatDateTime, formatUsd, humanize } from '../lib/format.js'

const ALL = ''

export interface ActivityFeedProps {
  /** Newest first, as the repository returns them. */
  events: AgentEvent[]
}

/** Section 15.1 Agent activity: what each agent did, in order, from `agent_events`. */
export function ActivityFeed({ events }: ActivityFeedProps) {
  const [agent, setAgent] = useState(ALL)
  const [traceId, setTraceId] = useState<string | null>(null)
  const agents = [...new Set(events.map((event) => event.agent))].sort()
  const shown = events.filter(
    (event) => (agent === ALL || event.agent === agent) && (traceId === null || event.traceId === traceId),
  )

  return (
    <>
      <div className="feed-filters">
        <label>
          Agent
          <select value={agent} onChange={(event) => setAgent(event.target.value)}>
            <option value={ALL}>All agents</option>
            {agents.map((name) => (
              <option key={name} value={name}>
                {humanize(name)}
              </option>
            ))}
          </select>
        </label>
        {traceId !== null && (
          <span className="feed-trace-filter">
            Trace <code>{traceId}</code>
            <button type="button" onClick={() => setTraceId(null)}>
              Show all traces
            </button>
          </span>
        )}
      </div>

      {events.length === 0 && <p className="muted">No agent activity recorded yet.</p>}
      <ol className="activity-feed" aria-label="Agent activity, newest first">
        {shown.map((event) => (
          <li key={event.id} data-event-id={event.id} className="activity-item">
            <time dateTime={event.createdAt}>{formatDateTime(event.createdAt)}</time>
            <div className="activity-body">
              <p className="activity-head">
                <span className={`badge agent-${event.agent}`}>{humanize(event.agent)}</span>
                <span>{humanize(event.eventType)}</span>
                <span className="muted">{formatUsd(event.costUsd)}</span>
              </p>
              {event.summary && <p className="activity-summary">{event.summary}</p>}
              <p className="activity-trace">
                <code>{event.traceId}</code>
                {traceId === null && (
                  <button type="button" aria-label={`Only trace ${event.traceId}`} onClick={() => setTraceId(event.traceId)}>
                    Only this trace
                  </button>
                )}
                {event.traceUrl && (
                  <a
                    href={event.traceUrl}
                    target="_blank"
                    rel="noreferrer noopener"
                    aria-label={`Open trace ${event.traceId} in Langfuse`}
                  >
                    Langfuse trace ↗
                  </a>
                )}
              </p>
            </div>
          </li>
        ))}
      </ol>
    </>
  )
}
