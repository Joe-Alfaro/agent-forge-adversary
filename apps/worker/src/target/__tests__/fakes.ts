import type { FetchLike, HttpRequestInit, HttpResponseLike, TransportClock } from '../transport.js'

/** A deterministic clock: `sleep` advances virtual time instead of waiting. */
export class FakeClock implements TransportClock {
  private current = 0
  readonly sleeps: number[] = []
  private uuidCounter = 0

  constructor(private readonly randomValue = 0.5) {}

  now(): number {
    return this.current
  }

  async sleep(ms: number): Promise<void> {
    this.sleeps.push(ms)
    this.current += ms
  }

  random(): number {
    return this.randomValue
  }

  randomUUID(): string {
    this.uuidCounter += 1
    const n = this.uuidCounter.toString(16).padStart(12, '0')
    return `00000000-0000-4000-8000-${n}`
  }

  advance(ms: number): void {
    this.current += ms
  }
}

export interface StubResponse {
  status: number
  body: unknown
  headers?: Record<string, string>
}

export interface RecordedRequest {
  url: string
  init: HttpRequestInit
}

/** A fetch stub that replays a queued list of responses and records requests. */
export function stubFetch(responses: StubResponse[]): {
  fetch: FetchLike
  requests: RecordedRequest[]
} {
  const queue = [...responses]
  const requests: RecordedRequest[] = []
  const fetch: FetchLike = async (url, init) => {
    requests.push({ url, init })
    const next = queue.shift()
    if (next === undefined) {
      throw new Error(`stubFetch ran out of responses for ${init.method} ${url}`)
    }
    return toResponse(next)
  }
  return { fetch, requests }
}

function toResponse(stub: StubResponse): HttpResponseLike {
  const headers = new Map(Object.entries(stub.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]))
  const bodyText = typeof stub.body === 'string' ? stub.body : JSON.stringify(stub.body)
  return {
    status: stub.status,
    headers: { get: (name: string) => headers.get(name.toLowerCase()) ?? null },
    text: async () => bodyText,
  }
}
