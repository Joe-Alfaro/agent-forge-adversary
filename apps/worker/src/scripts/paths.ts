import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** dist/scripts -> repo root -> evals/seeds (shared by the live scripts). */
function here(): string {
  return dirname(fileURLToPath(import.meta.url))
}

export function seedDir(): string {
  return join(here(), '..', '..', '..', '..', 'evals', 'seeds')
}

/** dist/scripts -> repo root -> evals/ground_truth. */
export function groundTruthDir(): string {
  return join(here(), '..', '..', '..', '..', 'evals', 'ground_truth')
}

/** dist/scripts -> repo root -> evals/results. */
export function resultsDir(): string {
  return join(here(), '..', '..', '..', '..', 'evals', 'results')
}
