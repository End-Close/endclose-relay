import { createHash } from 'node:crypto'
import type { EndCloseRecord } from './mapper.js'
import type { InstanceManifest } from '../engine/manifest.js'

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

/** End Close's public API. Override for staging via `endclose.baseUrl` / `ENDCLOSE_BASE_URL`. */
export const ENDCLOSE_API_URL = 'https://api.endclose.com/v1'

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

  /**
   * The routes document End Close holds for this API key's environment. The key is
   * environment-scoped, so nothing else selects the environment, and the status code is
   * the whole answer: 200 = End Close owns the configuration (body + ETag), 304 = owned
   * and unchanged since `etag`, 404 = not managed. Returns the parsed JSON body;
   * `fetchRemoteConfig` validates it.
   */
  async getRelayConfig(
    opts: { etag?: string; timeoutMs?: number } = {},
  ): Promise<{ status: 'document'; body: unknown; etag?: string } | { status: 'unchanged' }> {
    const res = await this.send('GET', '/relays/config', {
      headers: opts.etag ? { 'If-None-Match': opts.etag } : {},
      timeoutMs: opts.timeoutMs ?? 10_000,
    })
    // A 304 is only an answer to the conditional request we made; unsolicited, it is a
    // misbehaving proxy and must not be mistaken for "unchanged".
    if (res.status === 304 && opts.etag) return { status: 'unchanged' }
    this.assertOk(res)
    const etag = res.headers.get('etag')
    let body: unknown
    try {
      body = res.text ? JSON.parse(res.text) : null
    } catch (err) {
      throw new PermanentHttpError(`HTTP ${res.status} with a non-JSON body`, res.status, res.text.slice(0, 500))
    }
    return { status: 'document', body, ...(etag ? { etag } : {}) }
  }

  /** Register or refresh this instance's manifest. Failures must never affect ingest or dispatch. */
  async putRelayInstance(instanceId: string, manifest: InstanceManifest, opts: { timeoutMs?: number } = {}): Promise<void> {
    await this.request('PUT', `/relays/instances/${encodeURIComponent(instanceId)}`, {
      body: manifest,
      timeoutMs: opts.timeoutMs ?? 5_000,
    })
  }

  private async request(
    method: string,
    path: string,
    opts: { idempotencyKey?: string; body?: unknown; timeoutMs?: number },
  ): Promise<unknown> {
    const res = await this.send(method, path, {
      headers: opts.idempotencyKey ? { 'Idempotency-Key': opts.idempotencyKey } : {},
      ...(opts.body !== undefined ? { body: opts.body } : {}),
      timeoutMs: opts.timeoutMs ?? 30_000,
    })
    this.assertOk(res)
    return res.text ? JSON.parse(res.text) : {}
  }

  private async send(
    method: string,
    path: string,
    opts: { headers: Record<string, string>; body?: unknown; timeoutMs: number },
  ): Promise<{ status: number; ok: boolean; headers: Headers; text: string }> {
    let res: Response
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: { 'X-API-KEY': this.apiKey, 'Content-Type': 'application/json', ...opts.headers },
        body: opts.body === undefined ? null : JSON.stringify(opts.body),
        signal: AbortSignal.timeout(opts.timeoutMs),
      })
    } catch (err) {
      throw new TransientHttpError(`network error: ${(err as Error).message}`)
    }
    return { status: res.status, ok: res.ok, headers: res.headers, text: await res.text() }
  }

  private assertOk(res: { status: number; ok: boolean; text: string }): void {
    if (res.ok) return
    if (TRANSIENT_STATUSES.has(res.status)) throw new TransientHttpError(`HTTP ${res.status}`, res.status)
    throw new PermanentHttpError(`HTTP ${res.status}`, res.status, res.text.slice(0, 500))
  }
}
