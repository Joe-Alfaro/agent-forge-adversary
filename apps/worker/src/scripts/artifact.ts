import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { RunArtifact } from '@agentforge/db'

/** dist/scripts -> repo root -> evals/results (shared results directory). */
function resultsDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'evals', 'results')
}

/**
 * Writes a RunArtifact to disk for import into a database the run could not reach
 * (the deployed Railway dashboard). Transcripts inside the artifact are already
 * token/secret-redacted by the executor's redacting adapter. The path is
 * `RUN_ARTIFACT_OUT` when set, else evals/results/run-<version>-<key>.json.
 */
export function writeRunArtifact(artifact: RunArtifact): string {
  const explicit = process.env.RUN_ARTIFACT_OUT
  const version = artifact.target.version.replace(/[^a-zA-Z0-9@._-]/g, '_')
  const key = artifact.run_key.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 40)
  const outPath = explicit && explicit.length > 0 ? explicit : join(resultsDir(), `run-${version}-${key}.json`)
  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8')
  return outPath
}
