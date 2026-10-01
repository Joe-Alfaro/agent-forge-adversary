/**
 * The nightly run window (ARCHITECTURE 7.0: pg-boss cron, default 01:00 CT,
 * configurable). Resolves the next window start as a UTC instant, following the
 * zone's DST rules, without a date library.
 */

export interface NightlyWindowConfig {
  /** Local hour of the window start (0–23). Default 1. */
  hour?: number
  /** IANA time zone. Default America/Chicago (CT). */
  timeZone?: string
}

export const DEFAULT_NIGHTLY_HOUR = 1
export const DEFAULT_NIGHTLY_TIME_ZONE = 'America/Chicago'

interface LocalParts {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
}

function localParts(instant: Date, timeZone: string): LocalParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant)
  const get = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === type)?.value ?? 0)
  return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour'), minute: get('minute'), second: get('second') }
}

/** The zone's UTC offset (ms) at `instant`. */
function offsetMs(instant: Date, timeZone: string): number {
  const p = localParts(instant, timeZone)
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second)
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000
}

/** The UTC instant of local wall-clock `year-month-day hour:00` in `timeZone`. */
function zonedInstant(year: number, month: number, day: number, hour: number, timeZone: string): Date {
  const guess = Date.UTC(year, month - 1, day, hour)
  // Two passes settle the offset across a DST boundary.
  const first = guess - offsetMs(new Date(guess), timeZone)
  return new Date(guess - offsetMs(new Date(first), timeZone))
}

/** The next window start strictly after `now`. */
export function nextNightlyWindow(now: Date, config: NightlyWindowConfig = {}): Date {
  const hour = config.hour ?? DEFAULT_NIGHTLY_HOUR
  const timeZone = config.timeZone ?? DEFAULT_NIGHTLY_TIME_ZONE
  const today = localParts(now, timeZone)
  const candidate = zonedInstant(today.year, today.month, today.day, hour, timeZone)
  if (candidate.getTime() > now.getTime()) {
    return candidate
  }
  // Tomorrow's local date (Date.UTC normalizes day overflow).
  const tomorrow = new Date(Date.UTC(today.year, today.month - 1, today.day + 1))
  return zonedInstant(tomorrow.getUTCFullYear(), tomorrow.getUTCMonth() + 1, tomorrow.getUTCDate(), hour, timeZone)
}
