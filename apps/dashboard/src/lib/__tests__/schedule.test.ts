import { describe, expect, it } from 'vitest'

import { nextRunDate, runHourFromCron } from '../schedule.js'

describe('nextRunDate', () => {
  const options = { timeZone: 'America/Chicago', runHour: 1 }

  it('is tomorrow in the run time zone once today’s run hour has passed', () => {
    // 2026-09-29 15:00 CDT
    expect(nextRunDate(new Date('2026-09-29T20:00:00Z'), options)).toBe('2026-09-30')
  })

  it('is today before the run hour', () => {
    // 2026-09-30 00:30 CDT
    expect(nextRunDate(new Date('2026-09-30T05:30:00Z'), options)).toBe('2026-09-30')
  })

  it('uses the run time zone, not UTC, to pick the day', () => {
    // 2026-09-30 03:00 UTC is still 2026-09-29 22:00 CDT
    expect(nextRunDate(new Date('2026-09-30T03:00:00Z'), options)).toBe('2026-09-30')
  })

  it('rolls over month ends', () => {
    expect(nextRunDate(new Date('2026-10-31T20:00:00Z'), options)).toBe('2026-11-01')
  })
})

describe('runHourFromCron', () => {
  it('reads the hour field of a daily cron', () => {
    expect(runHourFromCron('0 1 * * *')).toBe(1)
    expect(runHourFromCron('30 23 * * *')).toBe(23)
  })

  it('falls back to 01:00 for missing or unusual expressions', () => {
    expect(runHourFromCron(undefined)).toBe(1)
    expect(runHourFromCron('*/5 * * * *')).toBe(1)
  })
})
