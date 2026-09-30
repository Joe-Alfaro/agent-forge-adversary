/**
 * Documentation Agent pass (Architecture 4.4): drafts a VulnReport v1 for every
 * confirmed-but-unreported exploit in DATABASE_URL, and records re-discoveries
 * of already-reported fingerprints as report history. Writes only `reports`
 * (drafts, or new versions) and `agent_events`. Safe to re-run.
 *
 * Usage (after `npm run build`):
 *   DATABASE_URL=postgres://localhost/agentforge npm run docs:generate -w apps/worker
 *
 * Env knobs: DOCS_MODE (llm | offline; offline = template narrative, no spend),
 * ANTHROPIC_API_KEY_DOCS (required for llm), DOCS_MAX_REPORTS (default 10 new
 * drafts per pass, bounding model spend).
 */
import Anthropic from '@anthropic-ai/sdk'
import pg from 'pg'

import { AnthropicNarrativeModel, OfflineNarrativeModel, PgDocsRepository, readDocsConfig, runDocumentationAgent } from '../docs/index.js'
import { loadEvalSuite } from '../evals/index.js'
import { buildCellOwaspMap } from '../orchestrator/index.js'
import { loadAgentforgeEnv } from './loadEnv.js'
import { seedDir } from './paths.js'

async function main(): Promise<void> {
  const envFile = loadAgentforgeEnv()
  console.log(envFile === null ? 'No AgentForge env file found.' : `Loaded env from ${envFile}`)
  const databaseUrl = (process.env.DATABASE_URL ?? '').trim()
  if (databaseUrl === '') {
    throw new Error('DATABASE_URL is not set.')
  }
  const config = readDocsConfig(process.env)
  const model =
    config.mode === 'offline'
      ? new OfflineNarrativeModel()
      : new AnthropicNarrativeModel({ client: new Anthropic({ apiKey: config.apiKey }) })
  const owaspByCell = buildCellOwaspMap(loadEvalSuite(seedDir()))

  const pool = new pg.Pool({ connectionString: databaseUrl, max: 2 })
  try {
    const summary = await runDocumentationAgent({
      repo: new PgDocsRepository(pool),
      model,
      now: () => new Date(),
      owaspFor: (category, subcategory) => owaspByCell[`${category}/${subcategory ?? ''}`] ?? [],
      maxReports: config.maxReports,
    })
    console.log(`\n=== Documentation Agent (${config.mode}, ${model.id}) ===`)
    console.log(`drafted: ${summary.drafted.join(', ') || 'none'}`)
    console.log(`history updated (re-discoveries): ${summary.rediscovered.join(', ') || 'none'}`)
    summary.failed.forEach((f) => console.log(`FAILED ${f.exploitId}: ${f.errors.join('; ')}`))
    summary.skipped.forEach((s) => console.log(`skipped ${s.exploitId}: ${s.reason}`))
    if (summary.deferred > 0) {
      console.log(`deferred to the next pass (DOCS_MAX_REPORTS=${config.maxReports}): ${summary.deferred}`)
    }
    console.log(`spend: $${summary.costUsd.toFixed(4)}`)
    if (summary.failed.length > 0) {
      process.exitCode = 1
    }
  } finally {
    await pool.end()
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
