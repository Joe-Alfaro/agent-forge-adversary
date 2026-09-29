const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' })

export function formatUsd(amount: number): string {
  return usd.format(amount)
}

export function formatPercent(ratio: number): string {
  return `${Math.round(ratio * 100)}%`
}

/** Turns snake_case enum values such as `in_progress` into readable labels. */
export function humanize(value: string): string {
  return value.replaceAll('_', ' ')
}

/** Dates render in UTC so server and client output match during hydration. */
export function formatDateTime(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`
}

export function formatDuration(startIso: string, endIso: string): string {
  const minutes = Math.round((Date.parse(endIso) - Date.parse(startIso)) / 60_000)
  const hours = Math.floor(minutes / 60)
  if (hours === 0) {
    return `${minutes}m`
  }
  return `${hours}h ${minutes % 60}m`
}
