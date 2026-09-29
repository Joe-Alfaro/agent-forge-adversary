/**
 * Auth-only diagnostic for the deployed Co-Pilot. Re-reads the operator env file
 * and tries POST /answer with the current COPILOT_TOKEN_SECRET, ruling out the two
 * usual non-secret causes of a 401 before concluding the value is wrong:
 *   1. a trailing newline / whitespace in the env value (raw vs trimmed), and
 *   2. clock skew (a longer token TTL).
 * It makes NO judge/Anthropic call and prints no secret value — only lengths and
 * the exact server responses.
 *
 * Usage: node apps/worker/dist/scripts/authPreflight.js
 */
import { Allowlist, CopilotClient, HttpTransport, type PatientBundle } from '../target/index.js'
import { loadAgentforgeEnv } from './loadEnv.js'

function syntheticBundle(pid: number): PatientBundle {
  return {
    pid,
    correlation_id: `preflight-${Date.now()}`,
    retrieved_at: new Date().toISOString(),
    sections: {
      demographics: { status: 'ok', count: 1, records: [{ _source: { table: 'patient_data', row_id: pid }, fname: 'Test', lname: 'Patient', DOB: '1970-01-01' }] },
    },
    recorded_absences: [],
    denied_sections: [],
  }
}

async function attempt(base: string, secret: string, ttl: number): Promise<{ status: number; body: unknown }> {
  const clock = { now: () => Date.now(), randomUUID: () => crypto.randomUUID() }
  const transport = new HttpTransport(
    new Allowlist([base]),
    (url, init) => fetch(url, init),
    { now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)), random: () => Math.random() },
    { rpm: 20, concurrency: 1, maxRetries: 2, backoffBaseMs: 500, backoffMaxMs: 5_000 },
  )
  const copilot = new CopilotClient(transport, { baseUrl: base, tokenSecret: secret, roleUserIds: { clinician: 1 }, tokenTtlSeconds: ttl }, clock)
  const session = copilot.newSession('clinician', syntheticBundle(1))
  const res = await copilot.answer(session, 'What are the current medications for this patient?', [], `preflight-${Date.now()}`)
  return { status: res.httpStatus, body: res.body }
}

async function main(): Promise<void> {
  const envFile = loadAgentforgeEnv()
  console.log(envFile === null ? 'No AgentForge env file found.' : `Loaded env from ${envFile}`)

  const base = process.env.COPILOT_BASE_URL ?? 'https://copilot-evidence-production.up.railway.app/'
  const raw = process.env.COPILOT_TOKEN_SECRET ?? ''
  const trimmed = raw.trim()
  if (raw === '') {
    console.error('COPILOT_TOKEN_SECRET is not set.')
    process.exitCode = 2
    return
  }
  console.log(`secret length raw=${raw.length} trimmed=${trimmed.length} trailing_ws=${raw !== trimmed}`)

  const trials: Array<{ label: string; secret: string; ttl: number }> = [
    { label: 'raw / ttl 300', secret: raw, ttl: 300 },
    { label: 'trimmed / ttl 300', secret: trimmed, ttl: 300 },
    { label: 'trimmed / ttl 900', secret: trimmed, ttl: 900 },
  ]

  for (const t of trials) {
    const { status, body } = await attempt(base, t.secret, t.ttl)
    console.log(`[${t.label}] -> ${status} ${JSON.stringify(body).slice(0, 200)}`)
    if (status !== 401) {
      console.log(`AUTH OK with ${t.label} (status ${status}). Use LIVE_TOKEN_TTL_SECONDS=${t.ttl}${t.secret === trimmed && raw !== trimmed ? ' and note the env value had trailing whitespace' : ''}.`)
      return
    }
  }
  console.error('All trials returned 401. Secret value does not match the deployed Co-Pilot after ruling out whitespace and TTL.')
  process.exitCode = 3
}

main().catch((error: unknown) => {
  console.error('auth-preflight failed:', error instanceof Error ? error.message : error)
  process.exitCode = 1
})
