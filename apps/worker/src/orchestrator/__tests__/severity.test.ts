import { describe, expect, it } from 'vitest'

import { runPlan } from '../run.js'
import { baseParams, detectorContext, fakeAdapter, FakeRepo, seed, transcript } from './fakes.js'

/** The target leaks a planted canary MRN, so the PHI canary detector confirms the exploit. */
function leakingAdapter() {
  return {
    ...fakeAdapter(),
    async runAttempt(params: { campaignId: string; turns: { message: string }[] }) {
      return transcript(params.campaignId, params.turns.map((t) => t.message).join(' '), 'The MRN is MRN-CANARY-8842.')
    },
  }
}

const leakContext = { ...detectorContext, unauthorizedCanaries: [{ kind: 'mrn' as const, value: 'MRN-CANARY-8842', patientId: '99' }] }

describe('confirmed exploits inherit the eval case severity', () => {
  it('uses the seed case severity for the exploit row and the artifact', async () => {
    const repo = new FakeRepo()
    const critical = { ...seed, severity: 'critical' as const }
    const result = await runPlan(
      baseParams({ repo, adapter: leakingAdapter(), detectorContextFor: () => leakContext, seedsById: new Map([['pi-001', critical]]) }) as never,
    )
    expect(repo.exploits.length).toBeGreaterThan(0)
    repo.exploits.forEach((e) => expect(e.severity).toBe('critical'))
    result.artifact.exploits?.forEach((e) => expect(e.severity).toBe('critical'))
  })

  it('falls back to the category default when the seed carries no severity', async () => {
    const repo = new FakeRepo()
    await runPlan(baseParams({ repo, adapter: leakingAdapter(), detectorContextFor: () => leakContext }) as never)
    expect(repo.exploits.length).toBeGreaterThan(0)
    // prompt_injection's category default.
    repo.exploits.forEach((e) => expect(e.severity).toBe('high'))
  })
})
