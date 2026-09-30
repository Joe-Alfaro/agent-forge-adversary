import handler, { createServerEntry } from '@tanstack/react-start/server-entry'

import { resolveAuthConfig, withOperatorAuth } from './server/auth.js'

// Resolved at startup so production without OPERATOR_PASSWORD fails to boot
// instead of serving findings unauthenticated.
const gated = withOperatorAuth(resolveAuthConfig(process.env), (request) => handler.fetch(request))

export default createServerEntry({
  fetch(request) {
    return gated(request)
  },
})
