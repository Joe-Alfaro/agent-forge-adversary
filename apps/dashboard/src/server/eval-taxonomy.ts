import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'

import type { CoverageCell } from '../lib/models.js'

/*
 * The attack taxonomy comes from the eval suite (evals/seeds/*.json), not from
 * a list in the dashboard, so a taxonomy change flows through without edits.
 * Seeds are parsed tolerantly: a malformed case or file is skipped, never fatal.
 */

export interface TaxonomyCell {
  category: string
  subcategory: string
  owaspIds: string[]
}

const UNSPECIFIED = 'unspecified'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function cellKey(cell: { category: string; subcategory: string }): string {
  return `${cell.category}\u0000${cell.subcategory}`
}

function byCell(a: TaxonomyCell, b: TaxonomyCell): number {
  return a.category.localeCompare(b.category) || a.subcategory.localeCompare(b.subcategory)
}

function union(a: string[], b: string[]): string[] {
  return [...new Set([...a, ...b])].sort()
}

export function taxonomyFromCases(cases: readonly unknown[]): TaxonomyCell[] {
  const cells = cases.reduce<Map<string, TaxonomyCell>>((found, item) => {
    if (!isRecord(item) || typeof item.category !== 'string' || item.category === '') {
      return found
    }
    const subcategory = typeof item.subcategory === 'string' && item.subcategory !== '' ? item.subcategory : UNSPECIFIED
    const cell = {
      category: item.category,
      subcategory,
      owaspIds: union(strings(item.owasp_llm_ids), strings(item.owasp_ids)),
    }
    const existing = found.get(cellKey(cell))
    found.set(cellKey(cell), existing ? { ...existing, owaspIds: union(existing.owaspIds, cell.owaspIds) } : cell)
    return found
  }, new Map())
  return [...cells.values()].sort(byCell)
}

async function readCases(file: string): Promise<unknown[]> {
  try {
    const parsed: unknown = JSON.parse(await readFile(file, 'utf8'))
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export async function loadEvalTaxonomy(dir: string): Promise<TaxonomyCell[]> {
  const entries = await readdir(dir).catch(() => [])
  const files = entries.filter((name) => name.endsWith('.json')).map((name) => path.join(dir, name))
  const cases = await Promise.all(files.map(readCases))
  return taxonomyFromCases(cases.flat())
}

/** Live coverage plus every taxonomy cell not yet attempted on this version (attempts 0). */
export function mergeCoverage(live: readonly CoverageCell[], taxonomy: readonly TaxonomyCell[]): CoverageCell[] {
  const liveByKey = new Map(live.map((cell) => [cellKey(cell), cell]))
  const planned = taxonomy.map((cell): CoverageCell => {
    const seen = liveByKey.get(cellKey(cell))
    if (!seen) {
      return { ...cell, attempts: 0, confirmed: 0 }
    }
    return { ...seen, owaspIds: union(seen.owaspIds, cell.owaspIds) }
  })
  const plannedKeys = new Set(taxonomy.map(cellKey))
  const unplanned = live.filter((cell) => !plannedKeys.has(cellKey(cell)))
  return [...planned, ...unplanned].sort(byCell)
}
