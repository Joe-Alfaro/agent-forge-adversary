import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import { isTaxonomyCell } from '@agentforge/contracts'

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

  it('uses only cells from the shared AttackTaxonomy v1', () => {
    suite.forEach((c) => {
      expect(isTaxonomyCell(c.category, c.subcategory)).toBe(true)
    })
  })
})

describe('loader rejects off-taxonomy cells', () => {
  it('rejects a category that is not in the taxonomy', () => {
    const base = suite[0]!
    expect(() => validateEvalCase({ ...base, category: 'sql_injection' }, 'test')).toThrow(/AttackTaxonomy/)
  })

  it('rejects a subcategory that is not in its category', () => {
    const base = suite[0]!
    expect(() => validateEvalCase({ ...base, subcategory: 'role_override' }, 'test')).toThrow(/AttackTaxonomy/)
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

describe('severity / exploitability / regression', () => {
  const base = suite[0]!

  it.each(['severity', 'exploitability', 'regression'] as const)('rejects a case missing %s', (field) => {
    const { [field]: _omit, ...rest } = base
    expect(() => validateEvalCase(rest, 'test')).toThrow(new RegExp(field))
  })

  it('rejects values outside the enums / a non-boolean regression flag', () => {
    expect(() => validateEvalCase({ ...base, severity: 'severe' }, 'test')).toThrow(/severity/)
    expect(() => validateEvalCase({ ...base, exploitability: 'easy' }, 'test')).toThrow(/exploitability/)
    expect(() => validateEvalCase({ ...base, regression: 'yes' }, 'test')).toThrow(/regression/)
  })

  it('gives every seed valid values (severity uses the exploits.severity enum)', () => {
    suite.forEach((c) => {
      expect(['critical', 'high', 'medium', 'low']).toContain(c.severity)
      expect(['high', 'medium', 'low']).toContain(c.exploitability)
      expect(typeof c.regression).toBe('boolean')
    })
  })

  it('rates every case in a cell the same (values are per THREAT_MODEL cell, not per case)', () => {
    const byCell = new Map<string, { severity: string; exploitability: string; regression: boolean }>()
    suite.forEach((c) => {
      const key = `${c.category}/${c.subcategory}`
      const seen = byCell.get(key)
      if (seen) expect({ severity: c.severity, exploitability: c.exploitability, regression: c.regression }).toEqual(seen)
      else byCell.set(key, { severity: c.severity, exploitability: c.exploitability, regression: c.regression })
    })
  })

  it('puts every THREAT_MODEL high-risk cell and every critical case in the regression suite, and nothing else', () => {
    // THREAT_MODEL.md: the six M5 high-risk cells plus the two high misinformation cells.
    const highRisk = new Set([
      'prompt_injection/direct',
      'prompt_injection/indirect',
      'data_exfiltration/authorization_bypass',
      'denial_of_service/token_exhaustion',
      'denial_of_service/cost_amplification',
      'identity_role_exploitation/persona_hijacking',
      'misinformation/unsupported_claim',
      'misinformation/fabricated_citation',
    ])
    suite.forEach((c) => {
      const expected = highRisk.has(`${c.category}/${c.subcategory}`) || c.severity === 'critical'
      expect({ id: c.id, regression: c.regression }).toEqual({ id: c.id, regression: expected })
    })
  })
})
