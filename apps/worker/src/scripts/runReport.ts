import type { RunPlanResult } from '../orchestrator/index.js'
import { writeRunArtifact } from './artifact.js'

/** Prints a nightly run's outcome and writes its importable RunArtifact. */
export function printRunResult(result: RunPlanResult, capUsd: number): void {
  console.log(`\n=== Nightly run (row ${result.nightlyRunId}) ===`)
  console.log(`status ${result.status}; attempts ${result.attempts}; ${result.verdictSplit.success}S/${result.verdictSplit.partial}P/${result.verdictSplit.fail}F needs_review ${result.verdictSplit.needs_review}`)
  console.log(`new tickets: ${result.newExploits.join(', ') || 'none'}; regressions: ${result.summary.regressions.join(', ') || 'none'}; verified fixes: ${result.summary.verified_fixes.join(', ') || 'none'}`)
  console.log(`refusal rate ${(result.refusalRate * 100).toFixed(1)}%`)
  console.log(`spend $${result.spendUsd.toFixed(3)} (cap $${capUsd}); trace ${result.traceUrl ?? '(tracing disabled)'}`)
  console.log(`artifact: ${writeRunArtifact(result.artifact)}`)
}
