import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import { loadEvalSuite, validateEvalCase, type EvalCase } from '../load.js'

const here = dirname(fileURLToPath(import.meta.url))
const seedDir = resolve(here, '../../../../../evals/seeds')

const KNOWN_DETECTORS = new Set(['phi_canary', 'cross_patient', 'tool_call_diff', 'scope_rule'])

let suite: EvalCase[]
try {
  suite = loadEvalSuite(seedDir)
} catch (error) {
  throw new Error(`Failed to load eval suite from ${seedDir}: ${(error as Error).message}`)
}

describe('seed eval suite', () => {
  it('covers at least three attack categories', () => {
    const categories = new Set(suite.map((c) => c.category))
    expect(categories.size).toBeGreaterThanOrEqual(3)
  })

  it('has multiple cases', () => {
    expect(suite.length).toBeGreaterThanOrEqual(9)
  })

  it('maps every case to at least one OWASP LLM Top 10 id (LLMxx)', () => {
    suite.forEach((c) => {
      expect(c.owasp_llm_ids.length).toBeGreaterThan(0)
      c.owasp_llm_ids.forEach((id) => expect(id).toMatch(/^LLM[0-9]{2}$/))
    })
  })

  it('maps every case to at least one OWASP Top 10 id (Axx)', () => {
    suite.forEach((c) => {
      expect(c.owasp_ids.length).toBeGreaterThan(0)
      c.owasp_ids.forEach((id) => expect(id).toMatch(/^A[0-9]{2}$/))
    })
  })

  it('gives every case a unique id', () => {
    const ids = suite.map((c) => c.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('references only known detectors', () => {
    suite.forEach((c) => {
      c.detectors.forEach((d) => expect(KNOWN_DETECTORS.has(d)).toBe(true))
    })
  })

  it('gives every case at least one turn with a message', () => {
    suite.forEach((c) => {
      expect(c.turns.length).toBeGreaterThan(0)
      c.turns.forEach((t) => expect(t.message.length).toBeGreaterThan(0))
    })
  })
})

describe('validateEvalCase', () => {
  const base = suite[0]!

  it('rejects a case missing its OWASP LLM mapping', () => {
    const { owasp_llm_ids: _omit, ...rest } = base
    expect(() => validateEvalCase(rest, 'test')).toThrow(/owasp_llm_ids/)
  })

  it('rejects a malformed OWASP web id', () => {
    expect(() => validateEvalCase({ ...base, owasp_ids: ['XSS'] }, 'test')).toThrow(/owasp_ids/)
  })

  it('rejects a case with no turns', () => {
    expect(() => validateEvalCase({ ...base, turns: [] }, 'test')).toThrow(/turns/)
  })
})
