import { describe, expect, it } from 'vitest'

import { Allowlist } from '../allowlist.js'
import { CopilotClient, type PatientBundle } from '../copilotClient.js'
import { HttpTransport, type TransportPolicy } from '../transport.js'
import { FakeClock, stubFetch } from './fakes.js'

const base = 'https://copilot-evidence-production.up.railway.app/'
const allow = new Allowlist([base])
const fastPolicy: TransportPolicy = {
  rpm: 1000,
  concurrency: 4,
  maxRetries: 5,
  backoffBaseMs: 500,
  backoffMaxMs: 30_000,
}

const bundle: PatientBundle = {
  pid: 42,
  correlation_id: 'c-1',
  retrieved_at: '2026-09-29T00:00:00Z',
  sections: {
    demographics: {
      status: 'ok',
      count: 1,
      records: [{ _source: { table: 'patient_data', row_id: 1 }, fname: 'Marta', lname: 'Vasquez' }],
    },
  },
  recorded_absences: [],
  denied_sections: [],
}

function makeClient(responses: Parameters<typeof stubFetch>[0]) {
  const clock = new FakeClock()
  const { fetch, requests } = stubFetch(responses)
  const transport = new HttpTransport(allow, fetch, clock, fastPolicy)
  const client = new CopilotClient(
    transport,
    { baseUrl: base, tokenSecret: 'secret', roleUserIds: { clinician: 7, nurse: 9 } },
    clock,
  )
  return { client, requests, clock }
}

describe('CopilotClient', () => {
  it('mints a session token bound to the bundle patient', () => {
    const { client } = makeClient([])
    const session = client.newSession('clinician', bundle)
    expect(session.pid).toBe(42)
    expect(session.userId).toBe(7)
    expect(session.token.split('.')).toHaveLength(3)
  })

  it('rejects an unknown role', () => {
    const { client } = makeClient([])
    expect(() => client.newSession('root', bundle)).toThrow(/Unknown role/)
  })

  it('posts the answer request with token, question, bundle and documents', async () => {
    const { client, requests } = makeClient([
      { status: 200, body: { claims: [], withheld_count: 0, outcome: 'all_passed', degraded: false } },
    ])
    const session = client.newSession('clinician', bundle)
    await client.answer(session, 'What are her medications?', [], 'trace-9')

    expect(requests).toHaveLength(1)
    const req = requests[0]!
    expect(req.url).toBe(`${base}answer`.replace('//answer', '/answer'))
    expect(req.init.headers['x-correlation-id']).toBe('trace-9')
    const sent = JSON.parse(req.init.body ?? '{}')
    expect(sent.token).toBe(session.token)
    expect(sent.question).toBe('What are her medications?')
    expect(sent.bundle.pid).toBe(42)
    expect(sent.documents).toEqual([])
  })

  it('extracts tool_sequence, degraded and usage from observability', async () => {
    const { client } = makeClient([
      {
        status: 200,
        body: {
          claims: [],
          withheld_count: 2,
          outcome: 'partial',
          degraded: true,
          observability: {
            tool_sequence: ['intake-extractor', 'evidence-retriever'],
            usage: { input_tokens: 1500, output_tokens: 300 },
          },
        },
      },
    ])
    const session = client.newSession('clinician', bundle)
    const result = await client.answer(session, 'hi')
    expect(result.toolSequence).toEqual(['intake-extractor', 'evidence-retriever'])
    expect(result.degraded).toBe(true)
    expect(result.tokenUsage).toEqual({ input_tokens: 1500, output_tokens: 300 })
  })

  it('reads the target version from /health build_commit', async () => {
    const { client, requests } = makeClient([
      { status: 200, body: { status: 'ok', service: 'copilot-evidence', build_commit: 'c1f011e' } },
    ])
    const version = await client.getVersion()
    expect(version).toBe('copilot@c1f011e')
    expect(requests[0]!.url).toBe(`${base}health`.replace('//health', '/health'))
  })

  it('surfaces a 401 as a normal result rather than throwing', async () => {
    const { client } = makeClient([{ status: 401, body: { error: 'unauthorized' } }])
    const session = client.newSession('clinician', bundle)
    const result = await client.answer(session, 'hi')
    expect(result.httpStatus).toBe(401)
  })
})
