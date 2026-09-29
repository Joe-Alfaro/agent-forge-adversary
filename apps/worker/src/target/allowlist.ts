import { TargetNotAllowlisted } from './errors.js'

/**
 * The allowlist of base URLs the adapter is permitted to reach. It is the
 * single choke point for scope control (Architecture Section 16): the Red Team
 * has no general HTTP client, and adding an entry is a human-gated operation
 * (G1). Comparison is on origin (scheme + host + port), so a path traversal or
 * an added query string cannot smuggle a request to a different host.
 */
export class Allowlist {
  private readonly origins: ReadonlySet<string>

  constructor(baseUrls: readonly string[]) {
    this.origins = new Set(baseUrls.map(originOf))
  }

  permits(url: string): boolean {
    try {
      return this.origins.has(new URL(url).origin)
    } catch {
      return false
    }
  }

  /** Throws {@link TargetNotAllowlisted} unless the URL's origin is allowed. */
  assert(url: string): void {
    if (!this.permits(url)) {
      throw new TargetNotAllowlisted(url)
    }
  }
}

function originOf(baseUrl: string): string {
  return new URL(baseUrl).origin
}
