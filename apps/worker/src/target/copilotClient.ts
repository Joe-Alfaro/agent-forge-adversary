import { mintScopedToken } from './scopedToken.js'
import type { HttpTransport } from './transport.js'

/**
 * Client for the Clinical Co-Pilot service. This is the primary attack path
 * because the Co-Pilot returns its own worker/tool sequence in the response
 * (`observability.tool_sequence`), which the tool-misuse detectors depend on
 * (Architecture Section 5.1, target fact F4).
 *
 * The live routes, discovered by reading the Phase 1-2 service and confirmed by
 * probing the deployment, are documented in `apps/worker/README.md`. The one
 * that matters is `POST /answer` (the OpenEMR panel calls the identical
 * `POST /brief`): route, extract, retrieve, synthesise, verify in one call.
 */

/** A patient chart section, as the Co-Pilot's `PatientBundle` carries it. */
export interface BundleSection {
  status: 'ok' | 'denied' | 'error'
  count: number
  records: Array<Record<string, unknown> & { _source: { table: string; row_id: number } }>
}

export interface PatientBundle {
  pid: number
  correlation_id: string
  retrieved_at: string
  sections: Partial<Record<string, BundleSection>>
  recorded_absences: string[]
  denied_sections: string[]
}

export interface AttachedDocument {
  document_id: string
  doc_type: 'lab_pdf' | 'intake_form'
  file_base64: string
}

export interface CopilotSession {
  id: string
  role: string
  userId: number
  pid: number
  token: string
  bundle: PatientBundle
}

export interface CopilotAnswerResult {
  httpStatus: number
  body: unknown
  toolSequence: string[]
  degraded: boolean
  tokenUsage: { input_tokens: number; output_tokens: number }
}

export interface CopilotClientConfig {
  baseUrl: string
  /** From env `COPILOT_TOKEN_SECRET`; never hard-coded. */
  tokenSecret: string
  /** Maps an attacker role name to the OpenEMR user id it authenticates as. */
  roleUserIds: Readonly<Record<string, number>>
  /** Token lifetime; short by default so a leaked token expires quickly. */
  tokenTtlSeconds?: number
}

export class CopilotClient {
  readonly name = 'copilot' as const
  readonly baseUrl: string

  constructor(
    private readonly transport: HttpTransport,
    private readonly config: CopilotClientConfig,
    private readonly clock: { now(): number; randomUUID(): string },
  ) {
    this.baseUrl = normalizeBase(config.baseUrl)
  }

  /**
   * Opens a session for a role against one patient's chart. The token is minted
   * for `bundle.pid`, so it authenticates only for that patient — asking about
   * another patient in the same session is exactly the cross-patient probe.
   */
  newSession(role: string, bundle: PatientBundle): CopilotSession {
    const userId = this.config.roleUserIds[role]
    if (userId === undefined) {
      throw new Error(`Unknown role: ${role}. Known roles: ${Object.keys(this.config.roleUserIds).join(', ')}`)
    }
    const id = this.clock.randomUUID()
    const token = mintScopedToken(this.config.tokenSecret, {
      userId,
      pid: bundle.pid,
      sessionFingerprint: id,
      ttlSeconds: this.config.tokenTtlSeconds ?? 300,
      issuedAtMs: this.clock.now(),
    })
    return { id, role, userId, pid: bundle.pid, token, bundle }
  }

  async answer(
    session: CopilotSession,
    question: string,
    documents: AttachedDocument[] = [],
    correlationId?: string,
  ): Promise<CopilotAnswerResult> {
    const url = `${this.baseUrl}/answer`
    const result = await this.transport.request(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(correlationId === undefined ? {} : { 'x-correlation-id': correlationId }),
      },
      body: JSON.stringify({
        token: session.token,
        question,
        bundle: session.bundle,
        documents,
      }),
    })

    const body = safeParseJson(result.body)
    return {
      httpStatus: result.status,
      body,
      toolSequence: extractToolSequence(body),
      degraded: extractDegraded(body),
      tokenUsage: extractUsage(body),
    }
  }

  /** The target version, taken from `/health`'s `build_commit`. */
  async getVersion(): Promise<string> {
    const result = await this.transport.request(`${this.baseUrl}/health`, {
      method: 'GET',
      headers: {},
    })
    const body = safeParseJson(result.body)
    const commit = isRecord(body) && typeof body['build_commit'] === 'string'
      ? body['build_commit']
      : 'unknown'
    return `copilot@${commit}`
  }
}

function normalizeBase(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '')
}

function safeParseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function extractToolSequence(body: unknown): string[] {
  if (!isRecord(body)) {
    return []
  }
  const obs = body['observability']
  if (!isRecord(obs)) {
    return []
  }
  const seq = obs['tool_sequence']
  if (!Array.isArray(seq)) {
    return []
  }
  return seq.filter((item): item is string => typeof item === 'string')
}

function extractDegraded(body: unknown): boolean {
  return isRecord(body) && body['degraded'] === true
}

function extractUsage(body: unknown): { input_tokens: number; output_tokens: number } {
  const zero = { input_tokens: 0, output_tokens: 0 }
  if (!isRecord(body)) {
    return zero
  }
  const obs = body['observability']
  if (!isRecord(obs)) {
    return zero
  }
  const usage = obs['usage']
  if (!isRecord(usage)) {
    return zero
  }
  const input = usage['input_tokens']
  const output = usage['output_tokens']
  return {
    input_tokens: typeof input === 'number' ? input : 0,
    output_tokens: typeof output === 'number' ? output : 0,
  }
}
