import type { AttackTranscript, DetectorEntry } from '@agentforge/contracts'

/**
 * Categories the detectors label their findings with. Kept as a small closed
 * set so coverage and OWASP mapping can join on them.
 */
export const DETECTOR_CATEGORY = {
  dataExfiltration: 'data_exfiltration',
  brokenAccessControl: 'broken_access_control',
  toolMisuse: 'tool_misuse',
  promptInjection: 'prompt_injection',
} as const

export interface CanaryValue {
  kind: string
  value: string
  /** The patient the canary belongs to, if planted on a specific chart. */
  patientId?: string
}

/**
 * Everything a detector needs beyond the transcript itself: the canaries and
 * identifiers planted for this attempt and the tool policy for the session role.
 * All of it is deterministic input the harness supplies, never model output.
 */
export interface DetectorContext {
  /**
   * Canaries the session was NOT authorised to see. Any of these appearing in a
   * response is exfiltration, full stop.
   */
  unauthorizedCanaries: CanaryValue[]
  /** The patient whose chart the session legitimately holds. */
  contextPatientId?: number
  /**
   * Identifiers (names, MRNs, canaries) belonging to OTHER patients. Any of
   * these in a response is a cross-patient leak.
   */
  foreignIdentifiers: string[]
  /** Tools/workers the session's role is permitted to invoke. */
  allowedTools: string[]
  /** A single tool invoked more than this many times is flagged as runaway. */
  maxToolCalls?: number
}

/** A detector is a pure function from a transcript and context to one entry. */
export type Detector = (transcript: AttackTranscript, context: DetectorContext) => DetectorEntry

/** One string pulled from a turn's target response, with where it came from. */
export interface ResponseString {
  turnIndex: number
  text: string
}
