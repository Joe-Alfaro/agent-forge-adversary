import {
  validateAttackTranscript,
  type AttackTranscript,
  type TranscriptTurn,
} from '@agentforge/contracts'

import type { AttachedDocument, CopilotClient, CopilotSession, PatientBundle } from './copilotClient.js'
import type { OpenEmrClient } from './openemrClient.js'
import { TokenCeilingExceeded } from './errors.js'

/**
 * The Target Adapter: the only network path to the target, presenting one
 * interface over the Co-Pilot and OpenEMR clients. It captures a full,
 * unredacted {@link AttackTranscript} for every attempt — with the target
 * version stamped on it — and enforces the per-attempt token ceiling. Allowlist,
 * rate limiting, and 429 backoff live one layer down in `HttpTransport`, which
 * both clients share (Architecture Section 5.1).
 */

export interface AdapterClock {
  now(): number
  randomUUID(): string
}

export interface AdapterDeps {
  copilot: CopilotClient
  clock: AdapterClock
  openemr?: OpenEmrClient
  /** Default per-attempt token ceiling; a plan's budget may lower it further. */
  defaultTokenCeiling?: number
}

export interface AttemptTurnInput {
  message: string
  documents?: AttachedDocument[]
}

export interface RunAttemptParams {
  campaignId: string
  traceId: string
  attemptId?: string
  session: CopilotSession
  turns: AttemptTurnInput[]
  tokenCeiling?: number
  /** What to do when the ceiling is reached: stop the attempt, or throw. */
  onCeiling?: 'stop' | 'throw'
}

export class TargetAdapter {
  constructor(private readonly deps: AdapterDeps) {}

  newSession(role: string, bundle: PatientBundle): CopilotSession {
    return this.deps.copilot.newSession(role, bundle)
  }

  getVersion(): Promise<string> {
    return this.deps.copilot.getVersion()
  }

  get openemr(): OpenEmrClient | undefined {
    return this.deps.openemr
  }

  /**
   * Runs a whole multi-turn attempt against the Co-Pilot and returns the
   * captured, schema-validated transcript. HTTP error responses (401, 400, 5xx)
   * are recorded as ordinary turns because they are themselves signal — a 401
   * `patient_mismatch` is a cross-patient probe being refused. Only a target
   * that is unreachable past the retry ceiling escapes as a thrown error.
   */
  async runAttempt(params: RunAttemptParams): Promise<AttackTranscript> {
    const { clock, copilot } = this.deps
    const attemptId = params.attemptId ?? clock.randomUUID()
    const ceiling = params.tokenCeiling ?? this.deps.defaultTokenCeiling ?? Number.POSITIVE_INFINITY
    const onCeiling = params.onCeiling ?? 'stop'
    const version = await copilot.getVersion()

    const turns: TranscriptTurn[] = []
    let cumulativeTokens = 0

    for (const [index, input] of params.turns.entries()) {
      if (cumulativeTokens >= ceiling) {
        if (onCeiling === 'throw') {
          throw new TokenCeilingExceeded({ used: cumulativeTokens, ceiling })
        }
        break
      }

      const startedAt = clock.now()
      const result = await copilot.answer(params.session, input.message, input.documents ?? [], params.traceId)
      const latencyMs = clock.now() - startedAt
      cumulativeTokens += result.tokenUsage.input_tokens + result.tokenUsage.output_tokens

      turns.push({
        index,
        attacker_message: input.message,
        ...(input.documents && input.documents.length > 0
          ? { attachments: input.documents.map((d) => ({ document_id: d.document_id, doc_type: d.doc_type })) }
          : {}),
        http_status: result.httpStatus,
        target_response: result.body,
        tool_sequence: result.toolSequence,
        degraded: result.degraded,
        latency_ms: latencyMs,
        token_usage: result.tokenUsage,
      })
    }

    const transcript: AttackTranscript = {
      schema_version: '1',
      message_id: clock.randomUUID(),
      campaign_id: params.campaignId,
      trace_id: params.traceId,
      attempt_id: attemptId,
      produced_by: 'target_adapter',
      produced_at: new Date(clock.now()).toISOString(),
      target: {
        name: 'copilot',
        base_url: ensureTrailingSlash(copilot.baseUrl),
        version,
      },
      session: {
        id: params.session.id,
        role: params.session.role,
        context_patient_id: params.session.pid,
      },
      turns,
      totals: totalsOf(turns),
    }

    // Producers validate before sending (Architecture Section 6.1). A transcript
    // that fails its own schema is a bug in this adapter, not a target finding.
    const check = validateAttackTranscript(transcript)
    if (!check.valid) {
      throw new Error(`TargetAdapter produced an invalid transcript: ${check.errors.join('; ')}`)
    }
    return transcript
  }
}

function totalsOf(turns: TranscriptTurn[]): AttackTranscript['totals'] {
  return turns.reduce(
    (totals, turn) => ({
      turns: totals.turns + 1,
      input_tokens: totals.input_tokens + turn.token_usage.input_tokens,
      output_tokens: totals.output_tokens + turn.token_usage.output_tokens,
      latency_ms: totals.latency_ms + turn.latency_ms,
    }),
    { turns: 0, input_tokens: 0, output_tokens: 0, latency_ms: 0 },
  )
}

function ensureTrailingSlash(url: string): string {
  return url.endsWith('/') ? url : `${url}/`
}
