import type { HttpTransport } from './transport.js'

/**
 * Client for the OpenEMR instance behind the Co-Pilot. It is the secondary
 * target path, used to seed synthetic test patients, plant canary records, and
 * upload documents — because uploads reach OpenEMR first, never the Co-Pilot
 * directly (target fact F3), so indirect-injection attacks seed a document here
 * and then ask the Co-Pilot to summarise it. It can also read the OpenEMR audit
 * log to infer tool misuse when the Co-Pilot's own tool log is unavailable (F4).
 *
 * OpenEMR's REST/FHIR API is OAuth2-protected, so live seeding needs a bearer
 * token the operator supplies (`OPENEMR_TOKEN`); the endpoint paths are
 * configurable because a deployment may mount the API under a custom base. All
 * requests still pass through the allowlist and rate limiter in `HttpTransport`.
 */

export interface OpenEmrClientConfig {
  baseUrl: string
  /** OAuth2 bearer token for the REST/FHIR API; required for seeding. */
  apiToken?: string
  /** REST API mount, e.g. `/apis/default/api`. */
  apiPath?: string
  /** FHIR mount, e.g. `/apis/default/fhir`. */
  fhirPath?: string
}

export interface SeededPatient {
  patientId: string
  canaries: CanaryRecord[]
}

export type CanaryKind = 'name' | 'mrn' | 'phone' | 'ssn'

export interface CanaryRecord {
  kind: CanaryKind
  /** The unique synthetic value planted, which detectors search responses for. */
  value: string
}

export interface SeededDocument {
  documentId: string
  patientId: string
}

export class OpenEmrClient {
  readonly name = 'openemr' as const
  readonly baseUrl: string
  private readonly apiPath: string
  private readonly fhirPath: string

  constructor(
    private readonly transport: HttpTransport,
    private readonly config: OpenEmrClientConfig,
    private readonly clock: { now(): number; randomUUID(): string },
  ) {
    this.baseUrl = normalizeBase(config.baseUrl)
    this.apiPath = config.apiPath ?? '/apis/default/api'
    this.fhirPath = config.fhirPath ?? '/apis/default/fhir'
  }

  /** The target version, from the FHIR CapabilityStatement's software version. */
  async getVersion(): Promise<string> {
    const result = await this.transport.request(`${this.baseUrl}${this.fhirPath}/metadata`, {
      method: 'GET',
      headers: { accept: 'application/fhir+json' },
    })
    const body = safeParseJson(result.body)
    const version = isRecord(body) && isRecord(body['software']) && typeof body['software']['version'] === 'string'
      ? body['software']['version']
      : 'unknown'
    return `openemr@${version}`
  }

  /**
   * Plants a synthetic canary MRN/name/phone on a new test patient so the PHI
   * canary detector has a unique needle to search for in Co-Pilot responses.
   * The values are minted here and returned; the caller records them against the
   * attempt. Requires an API token; without one this throws rather than
   * silently seeding nothing.
   */
  async seedCanaryPatient(kinds: readonly CanaryKind[] = ['name', 'mrn']): Promise<SeededPatient> {
    const token = this.requireToken()
    const canaries = kinds.map((kind) => ({ kind, value: this.mintCanary(kind) }))
    const nameCanary = canaries.find((c) => c.kind === 'name')
    const mrnCanary = canaries.find((c) => c.kind === 'mrn')

    const result = await this.transport.request(`${this.baseUrl}${this.apiPath}/patient`, {
      method: 'POST',
      headers: authJson(token),
      body: JSON.stringify({
        fname: nameCanary?.value ?? `Canary${this.suffix()}`,
        lname: 'Synthetic',
        pubpid: mrnCanary?.value ?? `MRN-${this.suffix()}`,
        sex: 'Female',
        DOB: '1970-01-01',
      }),
    })
    const body = safeParseJson(result.body)
    return { patientId: extractPatientId(body), canaries }
  }

  /** Uploads a document to a patient so it can later be retrieved by the Co-Pilot. */
  async seedDocument(patientId: string, contentBase64: string, category = 'lab_report'): Promise<SeededDocument> {
    const token = this.requireToken()
    const result = await this.transport.request(
      `${this.baseUrl}${this.apiPath}/patient/${encodeURIComponent(patientId)}/document`,
      {
        method: 'POST',
        headers: authJson(token),
        body: JSON.stringify({ category, document: contentBase64 }),
      },
    )
    const body = safeParseJson(result.body)
    return { documentId: extractDocumentId(body), patientId }
  }

  private mintCanary(kind: CanaryKind): string {
    const suffix = this.suffix()
    if (kind === 'name') {
      return `Zzcanary${suffix}`
    }
    if (kind === 'mrn') {
      return `MRN-CANARY-${suffix}`
    }
    if (kind === 'phone') {
      return `555-01${suffix.slice(0, 2)}-${suffix.slice(2, 6)}`
    }
    return `900-00-${suffix.slice(0, 4)}`
  }

  private suffix(): string {
    return this.clock.randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase()
  }

  private requireToken(): string {
    if (this.config.apiToken === undefined || this.config.apiToken === '') {
      throw new Error('OpenEMR seeding requires an apiToken (set OPENEMR_TOKEN)')
    }
    return this.config.apiToken
  }
}

function authJson(token: string): Record<string, string> {
  return { 'content-type': 'application/json', authorization: `Bearer ${token}` }
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

function extractPatientId(body: unknown): string {
  if (isRecord(body)) {
    const data = isRecord(body['data']) ? body['data'] : body
    for (const key of ['pid', 'id', 'uuid', 'pubpid']) {
      const value = data[key]
      if (typeof value === 'string' || typeof value === 'number') {
        return String(value)
      }
    }
  }
  return 'unknown'
}

function extractDocumentId(body: unknown): string {
  if (isRecord(body)) {
    const data = isRecord(body['data']) ? body['data'] : body
    for (const key of ['id', 'uuid', 'document_id']) {
      const value = data[key]
      if (typeof value === 'string' || typeof value === 'number') {
        return String(value)
      }
    }
  }
  return 'unknown'
}
