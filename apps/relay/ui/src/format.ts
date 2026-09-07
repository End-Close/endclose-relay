export function fmtDuration(s: number): string {
  if (s < 90) return `${s}s`
  if (s < 5400) return `${Math.round(s / 60)}m`
  if (s < 172800) return `${(s / 3600).toFixed(1)}h`
  return `${Math.round(s / 86400)}d`
}

export function fmtBytes(n: number): string {
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MiB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GiB`
}

export function fmtTime(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString() : '—'
}

export function fmtAgo(iso: string | null): string {
  if (!iso) return '—'
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000))
  return `${fmtDuration(s)} ago`
}
