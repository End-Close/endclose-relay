// Tuning knobs shared by createRelay() and the Dispatcher. One shape, camelCase.

export interface DispatchSettings {
  /** Records per bulk POST. */
  batchMax: number
  /** How often the loop wakes when idle (it also wakes immediately on ingest). */
  pollIntervalMs: number
  backoffBaseMs: number
  backoffCapMs: number
  /** Retrying events park (never dropped) after this long. */
  parkAfterMs: number
  /** How long a claimed batch is protected from recovery by other instances. */
  leaseMs: number
  /** How often a running instance sweeps for expired leases left by crashed peers. */
  recoverIntervalMs: number
}

export interface RetentionSettings {
  /** Payloads of delivered/filtered events are wiped after this many days. */
  deliveredDays: number
  /** Their rows (the idempotency ledger) are deleted after this many days. */
  ledgerDays: number
}

export const DEFAULT_DISPATCH: DispatchSettings = {
  batchMax: 100,
  pollIntervalMs: 250,
  backoffBaseMs: 1000,
  backoffCapMs: 600_000,
  parkAfterMs: 7 * 24 * 3600 * 1000,
  leaseMs: 600_000,
  recoverIntervalMs: 60_000,
}

export const DEFAULT_RETENTION: RetentionSettings = { deliveredDays: 7, ledgerDays: 30 }
