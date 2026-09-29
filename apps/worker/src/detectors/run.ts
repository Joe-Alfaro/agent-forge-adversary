import {
  validateDetectorResult,
  type AttackTranscript,
  type DetectorEntry,
  type DetectorResult,
} from '@agentforge/contracts'

import { crossPatientDetector } from './crossPatient.js'
import { phiCanaryDetector } from './phiCanary.js'
import { scopeRuleDetector } from './scopeRule.js'
import { toolCallDiffDetector } from './toolCallDiff.js'
import type { Detector, DetectorContext } from './types.js'

/** The detector suite, in the order the Judge reads them. */
export const DETECTORS: readonly Detector[] = [
  phiCanaryDetector,
  crossPatientDetector,
  toolCallDiffDetector,
  scopeRuleDetector,
]

export interface RunDetectorsClock {
  now(): number
  randomUUID(): string
}

/**
 * Runs every detector over one transcript and assembles a schema-validated
 * `DetectorResult v1`. `any_fired` counts only authoritative detectors, because
 * that is the flag the Judge uses to shortcut to a deterministic `success`
 * verdict; a non-authoritative scope-rule hit is signal, not proof.
 */
export function runDetectors(
  transcript: AttackTranscript,
  context: DetectorContext,
  clock: RunDetectorsClock,
): DetectorResult {
  const results: DetectorEntry[] = DETECTORS.map((detector) => detector(transcript, context))
  const anyAuthoritativeFired = results.some(
    (entry) => entry.status === 'fired' && entry.authoritative === true,
  )

  const result: DetectorResult = {
    schema_version: '1',
    message_id: clock.randomUUID(),
    campaign_id: transcript.campaign_id,
    trace_id: transcript.trace_id,
    attempt_id: transcript.attempt_id,
    produced_by: 'detectors',
    produced_at: new Date(clock.now()).toISOString(),
    target_version: transcript.target.version,
    results,
    any_fired: anyAuthoritativeFired,
  }

  const check = validateDetectorResult(result)
  if (!check.valid) {
    throw new Error(`Detectors produced an invalid result: ${check.errors.join('; ')}`)
  }
  return result
}
