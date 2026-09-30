export interface DocsConfig {
  mode: 'llm' | 'offline'
  apiKey?: string
  maxReports: number
}

/**
 * `DOCS_MODE=offline` drafts from templates with no model call. Otherwise the
 * Documentation Agent needs its own key, ANTHROPIC_API_KEY_DOCS; a missing key
 * is an error rather than a silent downgrade to template reports.
 */
export function readDocsConfig(env: NodeJS.ProcessEnv): DocsConfig {
  const mode = (env.DOCS_MODE ?? 'llm').trim()
  if (mode !== 'llm' && mode !== 'offline') {
    throw new Error(`DOCS_MODE must be "llm" or "offline", got "${mode}".`)
  }
  const maxReports = Number(env.DOCS_MAX_REPORTS ?? '10')
  if (!Number.isInteger(maxReports) || maxReports < 1) {
    throw new Error('DOCS_MAX_REPORTS must be a positive integer.')
  }
  if (mode === 'offline') {
    return { mode, maxReports }
  }
  const apiKey = (env.ANTHROPIC_API_KEY_DOCS ?? '').trim()
  if (apiKey === '') {
    throw new Error('ANTHROPIC_API_KEY_DOCS is not set. Set it, or run with DOCS_MODE=offline for template reports.')
  }
  return { mode, apiKey, maxReports }
}
