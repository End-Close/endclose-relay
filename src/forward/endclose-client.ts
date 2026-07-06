import { createHash } from 'node:crypto'
import type { EndCloseRecord } from './mapper.js'

export interface BulkRequestSummary {
  id: string
  status: string
  total_items?: number
  failed_items?: number
  skipped_items?: number
}

export interface BulkResultItem {
  index?: number
  external_id?: string
  status: string
  error?: string
}

export class TransientHttpError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message)
  }
}

export class PermanentHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message)
  }
}

const TRANSIENT_STATUSES = new Set([408, 429, 500, 502, 503, 504])

export class EndCloseClient {
  constructor(
    private baseUrl: string,
    private apiKey: string,
    private fetchImpl: typeof fetch = fetch,
  ) {}

  /** Deterministic per-batch idempotency key so a retried POST returns the original bulk request. */
  static idempotencyKey(records: EndCloseRecord[]): string {
    const h = createHash('sha256')
    for (const r of records) h.update(`${r.data_stream_key}:${r.external_id}\n`)
    return 'relay-' + h.digest('hex').slice(0, 40)
  }

  async bulkCreateRecords(records: EndCloseRecord[]): Promise<BulkRequestSummary> {
    return this.request('POST', '/records/bulk', {
      idempotencyKey: EndCloseClient.idempotencyKey(records),
      body: { on_conflict: 'skip', records },
    }) as Promise<BulkRequestSummary>
  }

  async getBulkRequest(id: string): Promise<BulkRequestSummary & { results?: BulkResultItem[] }> {
    return this.request('GET', `/bulk_requests/${id}`, {}) as Promise<
      BulkRequestSummary & { results?: BulkResultItem[] }
    >
  }

  private async request(
    method: string,
    path: string,
    opts: { idempotencyKey?: string; body?: unknown },
  ): Promise<unknown> {
    const headers: Record<string, string> = {
      'X-API-KEY': this.apiKey,
      'Content-Type': 'application/json',
    }
    if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey

    let res: Response
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: opts.body === undefined ? null : JSON.stringify(opts.body),
        signal: AbortSignal.timeout(30_000),
      })
    } catch (err) {
      throw new TransientHttpError(`network error: ${(err as Error).message}`)
    }

    const text = await res.text()
    if (res.ok) return text ? JSON.parse(text) : {}
    if (TRANSIENT_STATUSES.has(res.status)) {
      throw new TransientHttpError(`HTTP ${res.status}`, res.status)
    }
    throw new PermanentHttpError(`HTTP ${res.status}`, res.status, text.slice(0, 500))
  }
}
