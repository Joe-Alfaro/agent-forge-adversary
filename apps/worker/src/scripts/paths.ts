import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** dist/scripts -> repo root -> evals/seeds (shared by the live scripts). */
function here(): string {
  return dirname(fileURLToPath(import.meta.url))
}

/**
 * The seed suite directory. Defaults to the repo's `evals/seeds`; `RUN_SEED_DIR`
 * overrides it so a focused chase/attack set can be run in isolation without
 * adding cases to the standing suite. A relative override resolves against the
 * repo root (not cwd), so it works the same under `npm run -w apps/worker`,
 * which runs with cwd set to the workspace directory.
 */
function repoRoot(): string {
  return join(here(), '..', '..', '..', '..')
}

export function seedDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = (env.RUN_SEED_DIR ?? '').trim()
  if (override) {
    return isAbsolute(override) ? override : resolve(repoRoot(), override)
  }
  return join(repoRoot(), 'evals', 'seeds')
}

/** dist/scripts -> repo root -> evals/ground_truth. */
export function groundTruthDir(): string {
  return join(here(), '..', '..', '..', '..', 'evals', 'ground_truth')
}

/** dist/scripts -> repo root -> evals/results. */
export function resultsDir(): string {
  return join(here(), '..', '..', '..', '..', 'evals', 'results')
}
