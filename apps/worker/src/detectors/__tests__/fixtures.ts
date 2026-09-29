import type { AttackTranscript, TranscriptTurn } from '@agentforge/contracts'

export interface FixtureTurn {
  index?: number
  attacker_message?: string
  target_response?: unknown
  tool_sequence?: string[]
}

/** Builds a schema-shaped transcript from a short list of turn descriptions. */
export function transcriptFixture(turns: FixtureTurn[]): AttackTranscript {
  const fullTurns: TranscriptTurn[] = turns.map((turn, i) => ({
    index: turn.index ?? i,
    attacker_message: turn.attacker_message ?? 'attack',
    http_status: 200,
    target_response: turn.target_response ?? {},
    tool_sequence: turn.tool_sequence ?? [],
    degraded: false,
    latency_ms: 100,
    token_usage: { input_tokens: 10, output_tokens: 5 },
  }))

  return {
    schema_version: '1',
    message_id: '11111111-1111-4111-8111-111111111111',
    campaign_id: '22222222-2222-4222-8222-222222222222',
    trace_id: 'trace-abc',
    attempt_id: '33333333-3333-4333-8333-333333333333',
    produced_by: 'target_adapter',
    produced_at: '2026-09-29T01:00:00.000Z',
    target: {
      name: 'copilot',
      base_url: 'https://copilot-evidence-production.up.railway.app/',
      version: 'copilot@c1f011e',
    },
    session: { id: 'sess-1', role: 'clinician', context_patient_id: 42 },
    turns: fullTurns,
    totals: {
      turns: fullTurns.length,
      input_tokens: fullTurns.length * 10,
      output_tokens: fullTurns.length * 5,
      latency_ms: fullTurns.length * 100,
    },
  }
}

/** A Co-Pilot-shaped 200 response carrying claims with quoted values. */
export function copilotAnswer(quotedValues: string[], toolSequence: string[] = ['evidence-retriever']) {
  return {
    correlation_id: 'trace-abc',
    claims: quotedValues.map((value, i) => ({
      kind: 'finding',
      text: `Observed value ${value}.`,
      citation: { quote_or_value: value, field_or_chunk_id: `f${i}` },
    })),
    withheld_count: 0,
    outcome: 'all_passed',
    degraded: false,
    observability: { tool_sequence: toolSequence, usage: { input_tokens: 100, output_tokens: 20 } },
  }
}
