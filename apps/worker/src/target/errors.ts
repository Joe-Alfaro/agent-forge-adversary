/**
 * Typed errors for the Target Adapter, matching the error catalogue in
 * Architecture Section 6.3. They are thrown across the adapter's boundary so a
 * caller can distinguish "the target is down" (halt and alert) from "we hit the
 * budget" (halt and summarise) from a programming mistake.
 */

export type TargetErrorType =
  | 'TargetUnreachable'
  | 'BudgetExceeded'
  | 'TokenCeilingExceeded'
  | 'TargetNotAllowlisted'

export abstract class TargetError extends Error {
  abstract readonly type: TargetErrorType

  constructor(message: string) {
    super(message)
    this.name = new.target.name
  }
}

/**
 * The target could not be reached within the retry ceiling, or refused every
 * retry with a 429. Ends the campaign gracefully and alerts the operator.
 */
export class TargetUnreachable extends TargetError {
  readonly type = 'TargetUnreachable'

  constructor(
    message: string,
    readonly detail: { url: string; attempts: number; lastStatus?: number },
  ) {
    super(message)
  }
}

/** A per-target base URL that is not on the allowlist was requested. */
export class TargetNotAllowlisted extends TargetError {
  readonly type = 'TargetNotAllowlisted'

  constructor(readonly url: string) {
    super(`Target URL is not allowlisted: ${url}`)
  }
}

/**
 * The per-attempt token ceiling was reached. Raised before sending a further
 * turn once cumulative usage crosses the ceiling, so a single attempt cannot
 * run away with the shared Anthropic bill (Architecture Section 13.1 item 7).
 */
export class TokenCeilingExceeded extends TargetError {
  readonly type = 'TokenCeilingExceeded'

  constructor(readonly detail: { used: number; ceiling: number }) {
    super(`Per-attempt token ceiling exceeded: ${detail.used}/${detail.ceiling}`)
  }
}
