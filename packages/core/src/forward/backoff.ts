// Exponential backoff with ±20% jitter, Sequin-style: base * 2^attempts, capped.
export function backoffMs(attempts: number, baseMs = 1000, capMs = 600_000): number {
  const raw = Math.min(baseMs * 2 ** Math.min(attempts, 30), capMs)
  const jitter = 0.8 + Math.random() * 0.4
  return Math.round(raw * jitter)
}

export function nextAttemptAt(attempts: number, baseMs?: number, capMs?: number): string {
  return new Date(Date.now() + backoffMs(attempts, baseMs, capMs)).toISOString()
}
