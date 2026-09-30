import type { AttackTranscript, TranscriptTurn } from '@agentforge/contracts'

import { looksLikeRefusal } from '../models/refusal.js'
import { fingerprintTurns, mutateSeed, type MutationFamily, type SeedAttack } from './mutation.js'

/**
 * The Red Team campaign runner (ARCHITECTURE 4.2). It expands each seed into its
 * deterministic variant families (and, optionally, model-generated variants),
 * dedupes by fingerprint so a near-duplicate never reaches the target, and drives
 * every surviving attempt through the Target Adapter — the only network path to
 * the Co-Pilot. It emits AttackTranscripts and computes the per-campaign refusal
 * rate: the share of the target's responses that are refusals, measured with the
 * existing refusal detector.
 *
 * Budget and rate limiting are enforced below this layer: the adapter caps tokens
 * per attempt, and its transport enforces the allowlist, RPM, and concurrency.
 * This runner adds an attempt ceiling and an optional campaign token ceiling.
 */

/** A seed as a campaign consumes it (a superset of the mutation SeedAttack). */
export interface CampaignSeed {
  id: string
  category: string
  subcategory: string
  session_role: string
  turns: string[]
  technique_tags?: string[]
}

/** The minimal Target Adapter surface the runner needs (structural). */
export interface CampaignAdapter {
  getVersion(): Promise<string>
  runAttempt(params: {
    campaignId: string
    traceId: string
    attemptId?: string
    session: unknown
    turns: { message: string }[]
    tokenCeiling?: number
  }): Promise<AttackTranscript>
}

export interface CampaignClock {
  now(): number
  randomUUID(): string
}

export interface FamilyStat {
  attempts: number
  refusals: number
}

export interface CampaignResult {
  campaignId: string
  category: string
  targetVersion: string
  attempts: number
  refusals: number
  nonRefusals: number
  /** Share of attempts whose operative target response was a refusal. */
  refusalRate: number
  transcripts: AttackTranscript[]
  /** `seed` plus one key per mutation family. */
  byFamily: Record<string, FamilyStat>
  novelty: { unique: number; duplicatesSkipped: number }
}

export interface RunCampaignParams {
  adapter: CampaignAdapter
  seeds: CampaignSeed[]
  /** Opens a target session for a seed's role; passed opaquely to the adapter. */
  newSession: (seed: CampaignSeed) => unknown
  clock: CampaignClock
  /** Deterministic variants generated per family, per seed. */
  perFamily: number
  /** Hard ceiling on attempts across the whole campaign. */
  maxAttempts: number
  /** Restrict the deterministic mutation to a subset of families. */
  families?: readonly MutationFamily[]
  /** Per-attempt token ceiling handed to the adapter. */
  tokenCeiling?: number
  /** Optional campaign-wide token budget; the run stops once it is exceeded. */
  campaignTokenBudget?: number
  /**
   * Optional model-backed variant source (Haiku variants / Sonnet strategy via
   * the model router). Returns extra variant turn-lists for a seed. Refusals or
   * failures degrade gracefully to the deterministic families above.
   */
  modelVariants?: (seed: CampaignSeed) => Promise<VariantTurns[]>
  campaignId?: string
  traceId?: string
}

export interface VariantTurns {
  family: string
  turns: string[]
  techniqueTags?: string[]
}

/**
 * Extracts the target's response text from a transcript turn for refusal
 * detection: the Co-Pilot's accepted `claims[].text`, falling back to the
 * `reason` it returns when a response is fully withheld/degraded.
 */
export function targetResponseText(turn: Pick<TranscriptTurn, 'target_response'>): string {
  const body = turn.target_response
  if (typeof body !== 'object' || body === null) {
    return typeof body === 'string' ? body : ''
  }
  const record = body as Record<string, unknown>
  const claims = record['claims']
  if (Array.isArray(claims) && claims.length > 0) {
    return claims
      .map((c) => (typeof c === 'object' && c !== null ? String((c as Record<string, unknown>)['text'] ?? '') : ''))
      .filter((t) => t.length > 0)
      .join('\n')
  }
  const reason = record['reason']
  return typeof reason === 'string' ? reason : ''
}

/** True if an attempt's operative (last non-empty) target response is a refusal. */
function attemptWasRefused(transcript: AttackTranscript): boolean {
  const responded = [...transcript.turns].reverse().find((t) => targetResponseText(t).trim().length > 0)
  return responded !== undefined && looksLikeRefusal(targetResponseText(responded))
}

interface PlannedAttempt {
  family: string
  turns: string[]
  fingerprint: string
}

/** Builds the ordered, deduped attempt list for a seed: seed, deterministic, model. */
async function planSeedAttempts(
  seed: CampaignSeed,
  params: RunCampaignParams,
  seen: Set<string>,
): Promise<{ planned: PlannedAttempt[]; duplicatesSkipped: number }> {
  const planned: PlannedAttempt[] = []
  let duplicatesSkipped = 0

  const consider = (family: string, turns: string[]) => {
    const fingerprint = fingerprintTurns(turns)
    if (seen.has(fingerprint)) {
      duplicatesSkipped += 1
      return
    }
    seen.add(fingerprint)
    planned.push({ family, turns, fingerprint })
  }

  consider('seed', seed.turns)

  const mutationSeed: SeedAttack = {
    id: seed.id,
    category: seed.category,
    subcategory: seed.subcategory,
    turns: seed.turns,
    ...(seed.technique_tags ? { techniqueTags: seed.technique_tags } : {}),
  }
  mutateSeed(mutationSeed, { perFamily: params.perFamily, ...(params.families ? { families: params.families } : {}) }).forEach(
    (v) => consider(v.family, v.turns),
  )

  if (params.modelVariants) {
    try {
      const modelVs = await params.modelVariants(seed)
      modelVs.forEach((v) => consider(v.family, v.turns))
    } catch {
      // Model failure is non-fatal: the deterministic families stand in.
    }
  }

  return { planned, duplicatesSkipped }
}

export async function runCampaign(params: RunCampaignParams): Promise<CampaignResult> {
  const { adapter, seeds, clock } = params
  const campaignId = params.campaignId ?? clock.randomUUID()
  const targetVersion = await adapter.getVersion()

  const transcripts: AttackTranscript[] = []
  const byFamily: Record<string, FamilyStat> = {}
  const seen = new Set<string>()
  let attempts = 0
  let refusals = 0
  let duplicatesSkipped = 0
  let tokensSpent = 0

  const bump = (family: string, refused: boolean) => {
    const stat = byFamily[family] ?? { attempts: 0, refusals: 0 }
    stat.attempts += 1
    if (refused) stat.refusals += 1
    byFamily[family] = stat
  }

  for (const seed of seeds) {
    if (attempts >= params.maxAttempts) break
    const { planned, duplicatesSkipped: dup } = await planSeedAttempts(seed, params, seen)
    duplicatesSkipped += dup

    for (const attempt of planned) {
      if (attempts >= params.maxAttempts) break
      if (params.campaignTokenBudget !== undefined && tokensSpent >= params.campaignTokenBudget) break

      const transcript = await adapter.runAttempt({
        campaignId,
        traceId: params.traceId ?? `${campaignId}:${seed.id}:${attempt.family}:${attempt.fingerprint.slice(0, 8)}`,
        session: params.newSession(seed),
        turns: attempt.turns.map((message) => ({ message })),
        ...(params.tokenCeiling === undefined ? {} : { tokenCeiling: params.tokenCeiling }),
      })

      transcripts.push(transcript)
      attempts += 1
      tokensSpent += transcript.totals.input_tokens + transcript.totals.output_tokens
      const refused = attemptWasRefused(transcript)
      if (refused) refusals += 1
      bump(attempt.family, refused)
    }
  }

  const nonRefusals = attempts - refusals
  return {
    campaignId,
    category: seeds[0]?.category ?? 'unknown',
    targetVersion,
    attempts,
    refusals,
    nonRefusals,
    refusalRate: attempts === 0 ? 0 : refusals / attempts,
    transcripts,
    byFamily,
    novelty: { unique: attempts, duplicatesSkipped },
  }
}
