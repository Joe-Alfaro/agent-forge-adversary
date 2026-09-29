export interface RunSchedule {
  timeZone: string
  runHour: number
}

function datePartsIn(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date)
  const get = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value)
  return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour') }
}

/**
 * The calendar date (YYYY-MM-DD, in the run's time zone) of the next nightly
 * run. Requests made after today's run hour are for tomorrow's date.
 */
export function nextRunDate(now: Date, schedule: RunSchedule): string {
  const { year, month, day, hour } = datePartsIn(now, schedule.timeZone)
  const offsetDays = hour < schedule.runHour ? 0 : 1
  // Date.UTC normalizes day overflow, so month and year ends roll over correctly.
  return new Date(Date.UTC(year, month - 1, day + offsetDays)).toISOString().slice(0, 10)
}

const DEFAULT_RUN_HOUR = 1

/** Reads the hour from a daily cron such as `0 1 * * *`; anything else means 01:00. */
export function runHourFromCron(cron: string | undefined): number {
  const hourField = cron?.trim().split(/\s+/)[1]
  if (!hourField || !/^\d{1,2}$/.test(hourField)) {
    return DEFAULT_RUN_HOUR
  }
  const hour = Number(hourField)
  if (hour > 23) {
    return DEFAULT_RUN_HOUR
  }
  return hour
}
