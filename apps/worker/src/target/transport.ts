import { Allowlist } from './allowlist.js'
import { TargetUnreachable } from './errors.js'

/**
 * A minimal `fetch` shape, injectable so tests never touch the network. It is a
 * structural subset of the global `fetch` — the real one satisfies it.
 */
export interface HttpResponseLike {
  status: number
  headers: { get(name: string): string | null }
  text(): Promise<string>
}

export type FetchLike = (url: string, init: HttpRequestInit) => Promise<HttpResponseLike>

export interface HttpRequestInit {
  method: string
  headers: Record<string, string>
  body?: string
}

export interface TransportClock {
  now(): number
  sleep(ms: number): Promise<void>
  /** Returns a value in [0, 1); injected so backoff jitter is testable. */
  random(): number
}

export interface TransportPolicy {
  /** Requests per minute per transport. */
  rpm: number
  /** Max concurrent in-flight requests. */
  concurrency: number
  /** Retry ceiling for 429 / network errors before giving up. */
  maxRetries: number
  /** Base backoff in ms; the delay is `base * 2^attempt` plus jitter. */
  backoffBaseMs: number
  /** Cap on any single backoff delay. */
  backoffMaxMs: number
}

export const DEFAULT_POLICY: TransportPolicy = {
  rpm: 30,
  concurrency: 2,
  maxRetries: 5,
  backoffBaseMs: 500,
  backoffMaxMs: 30_000,
}

export interface TransportResult {
  status: number
  body: string
  headers: { get(name: string): string | null }
}

/**
 * The one component with network access to a target. It enforces the allowlist,
 * a per-target requests-per-minute limit and concurrency cap, and exponential
 * backoff with jitter on 429s honouring `Retry-After`. After the retry ceiling
 * it raises {@link TargetUnreachable} and never drops the work silently
 * (Architecture Sections 5.1, 13.2).
 */
export class HttpTransport {
  private readonly recentRequestTimes: number[] = []
  private inFlight = 0
  private readonly waiters: Array<() => void> = []

  constructor(
    private readonly allowlist: Allowlist,
    private readonly fetchImpl: FetchLike,
    private readonly clock: TransportClock,
    private readonly policy: TransportPolicy = DEFAULT_POLICY,
  ) {}

  async request(url: string, init: HttpRequestInit): Promise<TransportResult> {
    this.allowlist.assert(url)
    await this.acquireSlot()
    try {
      return await this.requestWithRetries(url, init)
    } finally {
      this.releaseSlot()
    }
  }

  private async requestWithRetries(url: string, init: HttpRequestInit): Promise<TransportResult> {
    let lastStatus: number | undefined
    let attempt = 0
    while (attempt <= this.policy.maxRetries) {
      await this.throttle()
      try {
        const response = await this.fetchImpl(url, init)
        if (response.status !== 429) {
          return { status: response.status, body: await response.text(), headers: response.headers }
        }
        lastStatus = 429
        await this.backoff(attempt, response.headers.get('retry-after'))
      } catch {
        // A network-level failure (DNS, reset, timeout) is retried on the same
        // backoff schedule as a 429; the target may simply be restarting.
        await this.backoff(attempt, null)
      }
      attempt += 1
    }
    throw new TargetUnreachable('Target retry ceiling exhausted', {
      url,
      attempts: attempt,
      ...(lastStatus === undefined ? {} : { lastStatus }),
    })
  }

  /** Sliding-window RPM limiter; sleeps until a request slot is free. */
  private async throttle(): Promise<void> {
    for (;;) {
      const now = this.clock.now()
      const windowStart = now - 60_000
      while (this.recentRequestTimes.length > 0 && (this.recentRequestTimes[0] ?? 0) <= windowStart) {
        this.recentRequestTimes.shift()
      }
      if (this.recentRequestTimes.length < this.policy.rpm) {
        this.recentRequestTimes.push(now)
        return
      }
      const oldest = this.recentRequestTimes[0] ?? now
      await this.clock.sleep(Math.max(1, oldest + 60_000 - now))
    }
  }

  private async backoff(attempt: number, retryAfter: string | null): Promise<void> {
    const retryAfterMs = parseRetryAfter(retryAfter)
    if (retryAfterMs !== null) {
      await this.clock.sleep(Math.min(retryAfterMs, this.policy.backoffMaxMs))
      return
    }
    const exponential = this.policy.backoffBaseMs * 2 ** attempt
    const capped = Math.min(exponential, this.policy.backoffMaxMs)
    const jittered = capped * (0.5 + this.clock.random() * 0.5)
    await this.clock.sleep(Math.round(jittered))
  }

  private async acquireSlot(): Promise<void> {
    if (this.inFlight < this.policy.concurrency) {
      this.inFlight += 1
      return
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve))
    this.inFlight += 1
  }

  private releaseSlot(): void {
    this.inFlight -= 1
    const next = this.waiters.shift()
    if (next !== undefined) {
      next()
    }
  }
}

/** `Retry-After` is either seconds or an HTTP date; returns ms or null. */
function parseRetryAfter(value: string | null): number | null {
  if (value === null || value.trim() === '') {
    return null
  }
  const seconds = Number(value)
  if (Number.isFinite(seconds)) {
    return Math.max(0, seconds * 1000)
  }
  const date = Date.parse(value)
  if (Number.isNaN(date)) {
    return null
  }
  return Math.max(0, date - Date.now())
}
