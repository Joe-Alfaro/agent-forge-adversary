import { describe, expect, it } from 'vitest'

import { validateAttackTranscript } from '@agentforge/contracts'

import { Allowlist } from '../allowlist.js'
import { CopilotClient, type PatientBundle } from '../copilotClient.js'
import { TargetAdapter } from '../adapter.js'
import { TokenCeilingExceeded } from '../errors.js'
import { HttpTransport, type TransportPolicy } from '../transport.js'
import { FakeClock, stubFetch, type StubResponse } from './fakes.js'

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
  sections: {},
  recorded_absences: [],
  denied_sections: [],
}

const health: StubResponse = {
  status: 200,
  body: { status: 'ok', service: 'copilot-evidence', build_commit: 'c1f011e' },
}

function answerResponse(usage: { input_tokens: number; output_tokens: number }): StubResponse {
  return {
    status: 200,
    body: {
      claims: [],
      withheld_count: 0,
      outcome: 'all_passed',
      degraded: false,
      observability: { tool_sequence: ['evidence-retriever'], usage },
    },
  }
}

function makeAdapter(responses: StubResponse[]) {
  const clock = new FakeClock()
  const { fetch, requests } = stubFetch(responses)
  const transport = new HttpTransport(allow, fetch, clock, fastPolicy)
  const copilot = new CopilotClient(
    transport,
    { baseUrl: base, tokenSecret: 'secret', roleUserIds: { clinician: 7 } },
    clock,
  )
  const adapter = new TargetAdapter({ copilot, clock })
  return { adapter, copilot, requests, clock }
}

describe('TargetAdapter.runAttempt', () => {
  it('captures a schema-valid multi-turn transcript stamped with the target version', async () => {
    const { adapter, copilot } = makeAdapter([
      health,
      answerResponse({ input_tokens: 100, output_tokens: 20 }),
      answerResponse({ input_tokens: 200, output_tokens: 30 }),
    ])
    const session = copilot.newSession('clinician', bundle)

    const transcript = await adapter.runAttempt({
      campaignId: '22222222-2222-4222-8222-222222222222',
      traceId: 'trace-abc',
      session,
      turns: [{ message: 'turn one' }, { message: 'turn two' }],
    })

    expect(validateAttackTranscript(transcript).valid).toBe(true)
    expect(transcript.target.version).toBe('copilot@c1f011e')
    expect(transcript.turns).toHaveLength(2)
    expect(transcript.turns[0]!.tool_sequence).toEqual(['evidence-retriever'])
    expect(transcript.session.context_patient_id).toBe(42)
    expect(transcript.totals).toMatchObject({ turns: 2, input_tokens: 300, output_tokens: 50 })
  })

  it('records attachments metadata for a document turn', async () => {
    const { adapter, copilot } = makeAdapter([health, answerResponse({ input_tokens: 1, output_tokens: 1 })])
    const session = copilot.newSession('clinician', bundle)
    const transcript = await adapter.runAttempt({
      campaignId: '22222222-2222-4222-8222-222222222222',
      traceId: 'trace-abc',
      session,
      turns: [
        {
          message: 'summarise this lab',
          documents: [{ document_id: 'doc-1', doc_type: 'lab_pdf', file_base64: 'QUJD' }],
        },
      ],
    })
    expect(transcript.turns[0]!.attachments).toEqual([{ document_id: 'doc-1', doc_type: 'lab_pdf' }])
  })

  it('stops sending turns once the per-attempt token ceiling is reached', async () => {
    const { adapter, copilot, requests } = makeAdapter([
      health,
      answerResponse({ input_tokens: 400, output_tokens: 200 }),
      // A second answer response is available but must not be requested.
      answerResponse({ input_tokens: 400, output_tokens: 200 }),
    ])
    const session = copilot.newSession('clinician', bundle)
    const transcript = await adapter.runAttempt({
      campaignId: '22222222-2222-4222-8222-222222222222',
      traceId: 'trace-abc',
      session,
      turns: [{ message: 'one' }, { message: 'two' }],
      tokenCeiling: 500,
    })
    expect(transcript.turns).toHaveLength(1)
    // /health + one /answer only.
    expect(requests).toHaveLength(2)
  })

  it('throws TokenCeilingExceeded when onCeiling is throw', async () => {
    const { adapter, copilot } = makeAdapter([
      health,
      answerResponse({ input_tokens: 400, output_tokens: 200 }),
    ])
    const session = copilot.newSession('clinician', bundle)
    await expect(
      adapter.runAttempt({
        campaignId: '22222222-2222-4222-8222-222222222222',
        traceId: 'trace-abc',
        session,
        turns: [{ message: 'one' }, { message: 'two' }],
        tokenCeiling: 500,
        onCeiling: 'throw',
      }),
    ).rejects.toBeInstanceOf(TokenCeilingExceeded)
  })
})
