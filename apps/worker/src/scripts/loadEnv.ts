import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Loads live secrets (COPILOT_TOKEN_SECRET, Anthropic keys, …) from the operator
 * env file, which lives OUTSIDE every worktree and is never committed:
 * `$AGENTFORGE_ENV_FILE`, defaulting to `~/.config/agentforge/.env`.
 *
 * Equivalent to running the script with `node --env-file-if-exists=<path>`, but
 * done in-process so the path can be resolved (`~`, the env var) and so it works
 * however the script is launched. It is a no-op if the file is absent, and it
 * never logs any value — only the resolved path.
 */
export function loadAgentforgeEnv(): string | null {
  const path = process.env.AGENTFORGE_ENV_FILE ?? join(homedir(), '.config', 'agentforge', '.env')
  if (!existsSync(path)) {
    return null
  }
  // Node 20.12+/22: loads KEY=VALUE lines into process.env.
  process.loadEnvFile(path)
  return path
}
