import type { OwaspMappedCase } from './owasp.js'

/** A seed case as the planner needs it: its id, cell, and OWASP mapping. */
export interface PlanningSeed extends OwaspMappedCase {
  id: string
}
