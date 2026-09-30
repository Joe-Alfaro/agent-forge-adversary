/** One `agent_events` row for the activity feed (Section 15.1, Agent activity). */
export interface AgentEvent {
  id: string
  traceId: string
  /** orchestrator, redteam, judge, documentation, harness, or target. */
  agent: string
  eventType: string
  costUsd: number
  createdAt: string
  /** Where the event came from, e.g. `run_import`. */
  source?: string
  /** Langfuse trace link, when the writer put one in the payload. */
  traceUrl?: string
  summary?: string
}

/** How many events the feed shows. */
export const ACTIVITY_LIMIT = 100
/** The feed refreshes itself while a run is going (Section 15.1: live feed). */
export const ACTIVITY_REFRESH_MS = 15_000

const SUMMARY_KEYS = ['summary', 'message', 'note', 'detail'] as const
const SUMMARY_MAX = 140

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A payload link is shown only when it is an absolute http(s) URL, never javascript: or data:. */
export function safeTraceUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined
  }
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:' ? value : undefined
  } catch {
    return undefined
  }
}

/** A one-line description from the free-form payload, if the writer included one. */
export function eventSummary(payload: unknown): string | undefined {
  if (!isRecord(payload)) {
    return undefined
  }
  const text = SUMMARY_KEYS.map((key) => payload[key]).find(
    (value): value is string => typeof value === 'string' && value.trim() !== '',
  )
  if (text === undefined) {
    return undefined
  }
  return text.length > SUMMARY_MAX ? `${text.slice(0, SUMMARY_MAX - 1)}…` : text
}

/** The payload's `trace_url`, validated. */
export function payloadTraceUrl(payload: unknown): string | undefined {
  return isRecord(payload) ? safeTraceUrl(payload.trace_url) : undefined
}
