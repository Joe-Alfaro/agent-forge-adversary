import { Langfuse } from 'langfuse'

/**
 * Platform-side tracing for AgentForge (ARCHITECTURE §15). Every campaign / live
 * Judge run is a trace; each agent step (target adapter call, detectors, judge
 * stages) is a span or generation carrying model, tokens, and the message IDs it
 * consumed and produced. Traces are tagged with the target `build_commit` and the
 * rubric hash.
 *
 * Two rules baked in here:
 *  - **No-op without keys.** When the Langfuse keys are absent the factory returns
 *    a tracer that does nothing and yields a null URL, so unit tests stay offline.
 *  - **Redaction.** Minted patient-scoped tokens and any configured secrets are
 *    stripped from every span input/output/metadata before it leaves the process.
 *    The Co-Pilot is not instrumented (operator decision): only platform spans.
 */

export interface PlatformSpan {
  name: string
  input?: unknown
  output?: unknown
  metadata?: Record<string, unknown>
}

export interface PlatformGeneration extends PlatformSpan {
  model?: string
  usage?: { input?: number; output?: number; total?: number }
}

export interface TraceScope {
  span(span: PlatformSpan): void
  generation(generation: PlatformGeneration): void
  update(metadata: Record<string, unknown>): void
  /** The Langfuse trace URL, or null when tracing is disabled. */
  url(): string | null
}

export interface StartTraceOptions {
  name: string
  buildCommit?: string
  rubricHash?: string
  metadata?: Record<string, unknown>
  tags?: string[]
}

export interface PlatformTracer {
  readonly enabled: boolean
  startTrace(options: StartTraceOptions): TraceScope
  flush(): Promise<void>
  shutdown(): Promise<void>
}

const SENSITIVE_KEYS = new Set([
  'token',
  'file_base64',
  'authorization',
  'api_key',
  'apikey',
  'secret',
  'password',
  'copilot_token_secret',
])

/**
 * Deep-redacts a value for tracing: drops values under sensitive keys and
 * replaces any occurrence of a known secret string. Returns a JSON-safe copy.
 */
export function redactForTrace(value: unknown, secrets: readonly string[] = []): unknown {
  const redactSecrets = secrets.filter((s) => typeof s === 'string' && s.length >= 8)
  const scrubString = (input: string): string =>
    redactSecrets.reduce((acc, secret) => acc.split(secret).join('[REDACTED]'), input)

  const walk = (input: unknown): unknown => {
    if (typeof input === 'string') {
      return scrubString(input)
    }
    if (Array.isArray(input)) {
      return input.map(walk)
    }
    if (typeof input === 'object' && input !== null) {
      const out: Record<string, unknown> = {}
      for (const [key, val] of Object.entries(input)) {
        out[key] = SENSITIVE_KEYS.has(key.toLowerCase()) ? '[REDACTED]' : walk(val)
      }
      return out
    }
    return input
  }

  return walk(value)
}

class NoopTracer implements PlatformTracer {
  readonly enabled = false

  startTrace(): TraceScope {
    return {
      span: () => {},
      generation: () => {},
      update: () => {},
      url: () => null,
    }
  }

  async flush(): Promise<void> {}
  async shutdown(): Promise<void> {}
}

class LangfuseTracer implements PlatformTracer {
  readonly enabled = true

  constructor(
    private readonly client: Langfuse,
    private readonly secrets: readonly string[],
  ) {}

  private redact(value: unknown): unknown {
    return value === undefined ? undefined : redactForTrace(value, this.secrets)
  }

  startTrace(options: StartTraceOptions): TraceScope {
    const tags = [
      ...(options.tags ?? []),
      ...(options.buildCommit ? [`build:${options.buildCommit}`] : []),
      ...(options.rubricHash ? [`rubric:${options.rubricHash}`] : []),
    ]
    const trace = this.client.trace({
      name: options.name,
      tags,
      metadata: {
        ...(options.metadata ?? {}),
        ...(options.buildCommit ? { build_commit: options.buildCommit } : {}),
        ...(options.rubricHash ? { rubric_hash: options.rubricHash } : {}),
      },
    })

    return {
      span: (span) => {
        trace
          .span({ name: span.name, input: this.redact(span.input), metadata: span.metadata })
          .end({ output: this.redact(span.output) })
      },
      generation: (generation) => {
        trace
          .generation({
            name: generation.name,
            ...(generation.model === undefined ? {} : { model: generation.model }),
            input: this.redact(generation.input),
            metadata: generation.metadata,
            ...(generation.usage === undefined
              ? {}
              : { usage: { ...generation.usage, unit: 'TOKENS' as const } }),
          })
          .end({ output: this.redact(generation.output) })
      },
      update: (metadata) => {
        trace.update({ metadata })
      },
      url: () => trace.getTraceUrl() ?? null,
    }
  }

  flush(): Promise<void> {
    return this.client.flushAsync()
  }

  shutdown(): Promise<void> {
    return this.client.shutdownAsync()
  }
}

export interface CreateTracerOptions {
  /** Secret strings to redact from every span payload (token secret, API keys). */
  secrets?: string[]
}

export interface LangfuseConfig {
  publicKey?: string
  secretKey?: string
  baseUrl?: string
  /** True when both keys are present and real tracing should be used. */
  enabled: boolean
}

/**
 * Resolves Langfuse configuration from the environment. Reads the current SDK
 * name `LANGFUSE_BASE_URL` and falls back to the older `LANGFUSE_BASEURL`. Pure
 * and side-effect-free so the fallback and enable logic are unit-testable offline.
 */
export function resolveLangfuseConfig(env: NodeJS.ProcessEnv = process.env): LangfuseConfig {
  const publicKey = env.LANGFUSE_PUBLIC_KEY || undefined
  const secretKey = env.LANGFUSE_SECRET_KEY || undefined
  const baseUrl = env.LANGFUSE_BASE_URL || env.LANGFUSE_BASEURL || undefined
  return {
    ...(publicKey ? { publicKey } : {}),
    ...(secretKey ? { secretKey } : {}),
    ...(baseUrl ? { baseUrl } : {}),
    enabled: Boolean(publicKey && secretKey),
  }
}

/**
 * Builds a tracer from the environment. Returns a no-op tracer (offline) when the
 * public/secret keys are absent.
 */
export function createTracer(
  env: NodeJS.ProcessEnv = process.env,
  options: CreateTracerOptions = {},
): PlatformTracer {
  const config = resolveLangfuseConfig(env)
  if (!config.enabled || config.publicKey === undefined || config.secretKey === undefined) {
    return new NoopTracer()
  }

  const client = new Langfuse({
    publicKey: config.publicKey,
    secretKey: config.secretKey,
    ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
  })
  const secrets = [config.secretKey, ...(options.secrets ?? [])]
  return new LangfuseTracer(client, secrets)
}
