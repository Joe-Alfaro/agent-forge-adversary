// @vitest-environment node
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import type { CoverageCell } from '../../lib/models.js'
import { loadEvalTaxonomy, mergeCoverage, taxonomyFromCases } from '../eval-taxonomy.js'

describe('taxonomyFromCases', () => {
  it('collects each category × subcategory once with the union of its OWASP ids', () => {
    expect(
      taxonomyFromCases([
        { category: 'state_corruption', subcategory: 'memory_poisoning', owasp_llm_ids: ['LLM04'], owasp_ids: [] },
        { category: 'state_corruption', subcategory: 'memory_poisoning', owasp_llm_ids: ['LLM08'] },
        { category: 'identity_role', subcategory: 'clinician_impersonation', owasp_ids: ['A07'] },
      ]),
    ).toEqual([
      { category: 'identity_role', subcategory: 'clinician_impersonation', owaspIds: ['A07'] },
      { category: 'state_corruption', subcategory: 'memory_poisoning', owaspIds: ['LLM04', 'LLM08'] },
    ])
  })

  it('skips malformed cases instead of failing the panel', () => {
    expect(taxonomyFromCases([null, 'x', { category: 7 }, { category: 'tool_misuse' }])).toEqual([
      { category: 'tool_misuse', subcategory: 'unspecified', owaspIds: [] },
    ])
  })
})

describe('mergeCoverage', () => {
  const live: CoverageCell[] = [
    { category: 'tool_misuse', subcategory: 'unauthorized_write', owaspIds: ['LLM06'], attempts: 5, confirmed: 1, lastRunAt: '2026-09-29T06:00:00.000Z' },
  ]

  it('adds untested taxonomy cells with zero attempts and keeps live counts', () => {
    const merged = mergeCoverage(live, [
      { category: 'tool_misuse', subcategory: 'unauthorized_write', owaspIds: ['A01'] },
      { category: 'denial_of_service', subcategory: 'token_flood', owaspIds: ['LLM10'] },
    ])
    expect(merged).toEqual([
      { category: 'denial_of_service', subcategory: 'token_flood', owaspIds: ['LLM10'], attempts: 0, confirmed: 0 },
      { ...live[0], owaspIds: ['A01', 'LLM06'] },
    ])
  })

  it('keeps live cells that the eval suite no longer lists', () => {
    expect(mergeCoverage(live, [])).toEqual(live)
  })
})

describe('loadEvalTaxonomy', () => {
  const dirs: string[] = []

  afterEach(async () => {
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
  })

  it('reads every JSON seed file in the directory', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'af-evals-'))
    dirs.push(dir)
    await writeFile(path.join(dir, 'a.json'), JSON.stringify([{ category: 'prompt_injection', subcategory: 'direct' }]))
    await writeFile(path.join(dir, 'b.json'), JSON.stringify([{ category: 'data_exfiltration', subcategory: 'markdown_image' }]))
    await writeFile(path.join(dir, 'broken.json'), '{not json')
    await writeFile(path.join(dir, 'notes.md'), '# ignored')
    const taxonomy = await loadEvalTaxonomy(dir)
    expect(taxonomy.map((cell) => `${cell.category}/${cell.subcategory}`)).toEqual([
      'data_exfiltration/markdown_image',
      'prompt_injection/direct',
    ])
  })

  it('returns nothing when the directory is missing', async () => {
    expect(await loadEvalTaxonomy('/definitely/not/here')).toEqual([])
  })
})
