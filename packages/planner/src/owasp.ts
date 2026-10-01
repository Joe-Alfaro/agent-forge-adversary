import { listTaxonomyCells } from '@agentforge/contracts'

/**
 * The OWASP mapping for each AttackTaxonomy cell. AttackTaxonomy v1 carries no
 * cell → OWASP table of its own; the mapping lives on the seed cases (every case
 * in `evals/seeds` must carry OWASP LLM Top 10 and OWASP Top 10 ids, enforced by
 * the eval loader), so a cell's mapping is the union over its seeds. LLM ids are
 * listed before web ids so the dashboard shows the LLM Top 10 first.
 */

export interface OwaspMappedCase {
  category: string
  subcategory: string
  owasp_llm_ids?: string[]
  owasp_ids?: string[]
}

/** `category/subcategory` → deduplicated OWASP ids (LLM Top 10 first, then web Top 10). */
export type CellOwaspMap = Record<string, string[]>

export function buildCellOwaspMap(cases: OwaspMappedCase[]): CellOwaspMap {
  const llm = new Map<string, Set<string>>()
  const web = new Map<string, Set<string>>()
  cases.forEach((c) => {
    const key = `${c.category}/${c.subcategory}`
    const llmIds = llm.get(key) ?? new Set<string>()
    const webIds = web.get(key) ?? new Set<string>()
    ;(c.owasp_llm_ids ?? []).forEach((id) => llmIds.add(id))
    ;(c.owasp_ids ?? []).forEach((id) => webIds.add(id))
    llm.set(key, llmIds)
    web.set(key, webIds)
  })
  return Object.fromEntries(
    [...llm.keys()]
      .map((key): [string, string[]] => [key, [...(llm.get(key) ?? []), ...(web.get(key) ?? [])]])
      .filter(([, ids]) => ids.length > 0),
  )
}

/** Taxonomy cells (`category/subcategory`) that resolve to no OWASP id. */
export function unmappedCells(map: CellOwaspMap): string[] {
  return listTaxonomyCells()
    .map((cell) => `${cell.category}/${cell.subcategory}`)
    .filter((key) => (map[key]?.length ?? 0) === 0)
}
