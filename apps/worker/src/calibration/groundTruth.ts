import { readFileSync } from 'node:fs'

import type { AttackTranscript, TranscriptTurn, VerdictOutcome } from '@agentforge/contracts'

import type { DetectorContext } from '../detectors/index.js'
import { rubricFor } from '../judge/index.js'

/**
 * The hand-labeled Judge calibration set (Architecture 8.3; KEY_METRICS M1, M2).
 * Each case is a complete attack attempt — what the attacker sent, what the
 * target answered, the tools it ran — plus the verdict a careful human gives it
 * and why. Stored as a compact JSON fixture in `evals/ground_truth/` and expanded
 * into a full `AttackTranscript` here, so the same case can be written to the
 * `ground_truth` table (Architecture 14.3) without changing shape.
 */

const OUTCOMES: ReadonlySet<string> = new Set(['success', 'partial', 'fail'])

/**
 * `clean_control`: a benign request with a correct answer — must be `fail` (M1).
 * `attack_defended`: a real attack the target resisted — `fail`.
 * `attack_success`: an attack that landed and only the LLM stage can see — `success`/`partial`.
 * `detector_success`: an attack an authoritative detector proves — decided at stage 1.
 */
export type GroundTruthKind = 'clean_control' | 'attack_defended' | 'attack_success' | 'detector_success'

const KINDS: ReadonlySet<string> = new Set(['clean_control', 'attack_defended', 'attack_success', 'detector_success'])

export interface GroundTruthTurn {
  attacker_message: string
  target_response: unknown
  tool_sequence?: string[]
  http_status?: number
}

export interface GroundTruthCase {
  id: string
  /** Rubric category the Judge scores this transcript against. */
  category: string
  kind: GroundTruthKind
  label: VerdictOutcome
  rationale: string
  /** The seed case this transcript was derived from, if any. */
  source_seed_id?: string
  session_role: string
  context_patient_id?: number
  turns: GroundTruthTurn[]
  detector_context: DetectorContext
}

export interface GroundTruthSet {
  version: string
  labeled_by: string
  labeled_at: string
  cases: GroundTruthCase[]
}

/** One row of the `ground_truth` table (Architecture 14.3). */
export interface GroundTruthRow {
  transcript: AttackTranscript
  label: VerdictOutcome
  category: string
  labeled_by: string
  labeled_at: string
}

export function loadGroundTruth(path: string): GroundTruthSet {
  return parseGroundTruth(JSON.parse(readFileSync(path, 'utf8')) as unknown)
}

/**
 * Validates a calibration set. It refuses the labeling mistakes that would make
 * the metrics lie: a clean control labeled as anything but `fail` (M1 would be
 * meaningless), a category with no frozen rubric (stage 2 could not run), or a
 * duplicate id (disagreements could not be matched across models).
 */
export function parseGroundTruth(value: unknown): GroundTruthSet {
  if (!isRecord(value) || !Array.isArray(value.cases)) {
    throw new Error('Ground-truth set must be an object with a "cases" array.')
  }
  const { version, labeled_by, labeled_at } = value
  if (typeof version !== 'string' || typeof labeled_by !== 'string' || typeof labeled_at !== 'string') {
    throw new Error('Ground-truth set needs string "version", "labeled_by" and "labeled_at".')
  }

  const cases = value.cases as GroundTruthCase[]
  const seen = new Set<string>()
  cases.forEach((c) => {
    const where = `ground-truth case "${String(c.id)}"`
    if (typeof c.id !== 'string' || c.id === '') {
      throw new Error('Every ground-truth case needs an id.')
    }
    if (seen.has(c.id)) {
      throw new Error(`${where}: duplicate id.`)
    }
    seen.add(c.id)
    if (rubricFor(c.category) === undefined) {
      throw new Error(`${where}: no frozen rubric for category "${c.category}".`)
    }
    if (!KINDS.has(c.kind)) {
      throw new Error(`${where}: unknown kind "${String(c.kind)}".`)
    }
    if (!OUTCOMES.has(c.label)) {
      throw new Error(`${where}: label must be success, partial or fail.`)
    }
    if (c.kind === 'clean_control' && c.label !== 'fail') {
      throw new Error(`${where}: a clean control must be labeled fail.`)
    }
    if (typeof c.rationale !== 'string' || c.rationale.trim() === '') {
      throw new Error(`${where}: missing rationale.`)
    }
    if (!Array.isArray(c.turns) || c.turns.length === 0) {
      throw new Error(`${where}: needs at least one turn.`)
    }
    if (!isRecord(c.detector_context) || !Array.isArray(c.detector_context.allowedTools)) {
      throw new Error(`${where}: needs a detector_context.`)
    }
  })

  return { version, labeled_by, labeled_at, cases }
}

/**
 * Expands a compact case into a schema-shaped transcript. Ids are derived from
 * the case id so every run of the calibration set judges byte-identical input.
 */
export function toTranscript(c: GroundTruthCase, targetVersion: string): AttackTranscript {
  const turns: TranscriptTurn[] = c.turns.map((turn, index) => ({
    index,
    attacker_message: turn.attacker_message,
    http_status: turn.http_status ?? 200,
    target_response: turn.target_response,
    tool_sequence: turn.tool_sequence ?? [],
    degraded: false,
    latency_ms: 0,
    token_usage: { input_tokens: 0, output_tokens: 0 },
  }))
  const id = stableUuid(c.id)
  return {
    schema_version: '1',
    message_id: id,
    campaign_id: id,
    trace_id: `calibration-${c.id}`,
    attempt_id: id,
    produced_by: 'target_adapter',
    produced_at: '2026-09-30T00:00:00.000Z',
    target: { name: 'copilot', base_url: 'https://copilot-evidence-production.up.railway.app/', version: targetVersion },
    session: {
      id: `calibration-${c.id}`,
      role: c.session_role,
      ...(c.context_patient_id === undefined ? {} : { context_patient_id: c.context_patient_id }),
    },
    turns,
    totals: { turns: turns.length, input_tokens: 0, output_tokens: 0, latency_ms: 0 },
  }
}

export function toGroundTruthRow(c: GroundTruthCase, set: GroundTruthSet): GroundTruthRow {
  return {
    transcript: toTranscript(c, `copilot@${set.version}`),
    label: c.label,
    category: c.category,
    labeled_by: set.labeled_by,
    labeled_at: set.labeled_at,
  }
}

/** A deterministic, v4-shaped UUID from a case id (FNV-1a, hex-expanded). */
function stableUuid(seed: string): string {
  const hex = [0, 1, 2, 3]
    .map((salt) => fnv1a(`${salt}:${seed}`).toString(16).padStart(8, '0'))
    .join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

function fnv1a(input: string): number {
  return [...input].reduce((hash, ch) => Math.imul(hash ^ ch.charCodeAt(0), 0x01000193) >>> 0, 0x811c9dc5)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
