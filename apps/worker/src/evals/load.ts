import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { isTaxonomyCell } from '@agentforge/contracts'

/**
 * Loader and validator for the seed eval suite in `evals/seeds/`. Every case is
 * mapped to its OWASP LLM Top 10 and OWASP Top 10 categories — the one required
 * engineering deliverable (Architecture 2.1) — and this loader is what enforces
 * that mapping is present and well-formed on every case, so a case can never
 * enter the suite unmapped.
 */

const OWASP_LLM = /^LLM[0-9]{2}$/
const OWASP_WEB = /^A[0-9]{2}$/
const OUTCOMES = new Set(['success', 'partial', 'fail'])
/** Same enum as exploits.severity, so a case's severity can carry onto its ticket. */
export const EVAL_SEVERITIES = ['critical', 'high', 'medium', 'low'] as const
/** Ease of success: the inverse of THREAT_MODEL's "difficulty of exploitation". */
export const EVAL_EXPLOITABILITIES = ['high', 'medium', 'low'] as const

export type EvalSeverity = (typeof EVAL_SEVERITIES)[number]
export type EvalExploitability = (typeof EVAL_EXPLOITABILITIES)[number]

export interface EvalAttachment {
  doc_type: string
  /** Injected instruction planted in the document body (indirect injection). */
  injected_text?: string
}

export interface EvalTurn {
  message: string
  attachments?: EvalAttachment[]
}

export interface EvalCase {
  id: string
  category: string
  subcategory: string
  title: string
  description: string
  owasp_llm_ids: string[]
  owasp_ids: string[]
  technique_tags: string[]
  session_role: string
  turns: EvalTurn[]
  detectors: string[]
  expected_secure_outcome: 'success' | 'partial' | 'fail'
  /** Impact if the attack succeeds (THREAT_MODEL "potential impact"; see evals/README.md). */
  severity: EvalSeverity
  /** Ease/likelihood of success = the inverse of THREAT_MODEL's difficulty. */
  exploitability: EvalExploitability
  /** Part of the standing regression suite, re-run on every target version. */
  regression: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(message)
  }
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string')
}

export function validateEvalCase(value: unknown, source: string): EvalCase {
  const where = `${source}`
  assert(isRecord(value), `${where}: case is not an object`)
  const c = value
  const id = c['id']
  assert(typeof id === 'string' && id.length > 0, `${where}: missing id`)
  const at = `${where} [${String(id)}]`

  for (const field of ['category', 'subcategory', 'title', 'description', 'session_role']) {
    assert(typeof c[field] === 'string' && (c[field] as string).length > 0, `${at}: ${field} must be a non-empty string`)
  }

  // The category/subcategory must be a real cell in the shared AttackTaxonomy v1.
  // This is what keeps evals, coverage_snapshots, and the dashboard on one set of
  // keys; a typo or a stale category name is rejected at load time.
  assert(
    isTaxonomyCell(c['category'] as string, c['subcategory'] as string),
    `${at}: ${String(c['category'])}/${String(c['subcategory'])} is not a cell in AttackTaxonomy v1`,
  )

  assert(isStringArray(c['owasp_llm_ids']) && c['owasp_llm_ids'].length > 0, `${at}: owasp_llm_ids must be a non-empty string array`)
  assert(
    (c['owasp_llm_ids'] as string[]).every((v) => OWASP_LLM.test(v)),
    `${at}: every owasp_llm_ids entry must match ${OWASP_LLM}`,
  )
  assert(isStringArray(c['owasp_ids']) && c['owasp_ids'].length > 0, `${at}: owasp_ids must be a non-empty string array`)
  assert(
    (c['owasp_ids'] as string[]).every((v) => OWASP_WEB.test(v)),
    `${at}: every owasp_ids entry must match ${OWASP_WEB}`,
  )

  assert(isStringArray(c['technique_tags']), `${at}: technique_tags must be a string array`)
  assert(isStringArray(c['detectors']), `${at}: detectors must be a string array`)
  assert(
    typeof c['expected_secure_outcome'] === 'string' && OUTCOMES.has(c['expected_secure_outcome']),
    `${at}: expected_secure_outcome must be one of success|partial|fail`,
  )

  assert(
    typeof c['severity'] === 'string' && (EVAL_SEVERITIES as readonly string[]).includes(c['severity']),
    `${at}: severity must be one of ${EVAL_SEVERITIES.join('|')}`,
  )
  assert(
    typeof c['exploitability'] === 'string' && (EVAL_EXPLOITABILITIES as readonly string[]).includes(c['exploitability']),
    `${at}: exploitability must be one of ${EVAL_EXPLOITABILITIES.join('|')}`,
  )
  assert(typeof c['regression'] === 'boolean', `${at}: regression must be a boolean`)

  const turns = c['turns']
  assert(Array.isArray(turns) && turns.length > 0, `${at}: turns must be a non-empty array`)
  const parsedTurns: EvalTurn[] = turns.map((turn, i) => {
    assert(isRecord(turn) && typeof turn['message'] === 'string' && turn['message'].length > 0, `${at}: turn ${i} needs a message`)
    const attachments = turn['attachments']
    if (attachments === undefined) {
      return { message: turn['message'] }
    }
    assert(Array.isArray(attachments), `${at}: turn ${i} attachments must be an array`)
    const parsedAttachments: EvalAttachment[] = attachments.map((a, j) => {
      assert(isRecord(a) && typeof a['doc_type'] === 'string', `${at}: turn ${i} attachment ${j} needs a doc_type`)
      const injected = a['injected_text']
      return {
        doc_type: a['doc_type'],
        ...(typeof injected === 'string' ? { injected_text: injected } : {}),
      }
    })
    return { message: turn['message'], attachments: parsedAttachments }
  })

  return {
    id,
    category: c['category'] as string,
    subcategory: c['subcategory'] as string,
    title: c['title'] as string,
    description: c['description'] as string,
    owasp_llm_ids: c['owasp_llm_ids'] as string[],
    owasp_ids: c['owasp_ids'] as string[],
    technique_tags: c['technique_tags'] as string[],
    session_role: c['session_role'] as string,
    turns: parsedTurns,
    detectors: c['detectors'] as string[],
    expected_secure_outcome: c['expected_secure_outcome'] as EvalCase['expected_secure_outcome'],
    severity: c['severity'] as EvalSeverity,
    exploitability: c['exploitability'] as EvalExploitability,
    regression: c['regression'] as boolean,
  }
}

export function defaultSeedDir(): string {
  return join(process.cwd(), 'evals', 'seeds')
}

/** Loads and validates every `*.json` case file in the seed directory. */
export function loadEvalSuite(dir: string = defaultSeedDir()): EvalCase[] {
  const files = readdirSync(dir).filter((name) => name.endsWith('.json')).sort()
  const cases: EvalCase[] = []
  const seen = new Set<string>()

  files.forEach((file) => {
    const raw: unknown = JSON.parse(readFileSync(join(dir, file), 'utf8'))
    assert(Array.isArray(raw), `${file}: top level must be an array of cases`)
    raw.forEach((entry, i) => {
      const parsed = validateEvalCase(entry, `${file}#${i}`)
      assert(!seen.has(parsed.id), `${file}: duplicate case id ${parsed.id}`)
      seen.add(parsed.id)
      cases.push(parsed)
    })
  })

  return cases
}
