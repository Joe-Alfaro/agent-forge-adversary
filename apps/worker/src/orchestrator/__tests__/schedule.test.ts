import { describe, expect, it } from 'vitest'

import { nextNightlyWindow } from '../schedule.js'

describe('nextNightlyWindow', () => {
  it('returns tonight 01:00 CT when it is still ahead (CDT, UTC-5)', () => {
    // 2026-09-29 21:00 CDT = 2026-09-30T02:00Z; next 01:00 CDT is 2026-09-30T06:00Z.
    expect(nextNightlyWindow(new Date('2026-09-30T02:00:00Z')).toISOString()).toBe('2026-09-30T06:00:00.000Z')
  })

  it('rolls to the next day once today’s window has passed', () => {
    // 2026-09-30 01:30 CDT -> 2026-10-01 01:00 CDT.
    expect(nextNightlyWindow(new Date('2026-09-30T06:30:00Z')).toISOString()).toBe('2026-10-01T06:00:00.000Z')
  })

  it('rolls forward when exactly at the window', () => {
    expect(nextNightlyWindow(new Date('2026-09-30T06:00:00Z')).toISOString()).toBe('2026-10-01T06:00:00.000Z')
  })

  it('handles standard time (CST, UTC-6)', () => {
    expect(nextNightlyWindow(new Date('2026-12-01T12:00:00Z')).toISOString()).toBe('2026-12-02T07:00:00.000Z')
  })

  it('honours a configured hour and time zone', () => {
    expect(nextNightlyWindow(new Date('2026-09-29T12:00:00Z'), { hour: 3, timeZone: 'UTC' }).toISOString()).toBe('2026-09-30T03:00:00.000Z')
  })
})
