/** Shared HTTP client for relayctl → local admin API. */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {
    const msg =
      body && typeof body === 'object' && 'error' in body
        ? String((body as { error: unknown }).error)
        : typeof body === 'string'
          ? body
          : `HTTP ${status}`
    super(msg)
    this.name = 'ApiError'
  }
}

export interface AdminClientOptions {
  baseUrl: string
  /** user:password — taken from ADMIN_BASIC_AUTH in-container so operators never type it. */
  basicAuth: string
}

export class AdminClient {
  readonly baseUrl: string
  private readonly authHeader: string

  constructor(opts: AdminClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '')
    this.authHeader = 'Basic ' + Buffer.from(opts.basicAuth, 'utf8').toString('base64')
  }

  async request<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; data: T }> {
    const headers: Record<string, string> = {
      authorization: this.authHeader,
      accept: 'application/json',
      'user-agent': 'relayctl',
    }
    const init: RequestInit = { method, headers }
    if (body !== undefined) {
      headers['content-type'] = 'application/json'
      init.body = JSON.stringify(body)
    }
    const res = await fetch(`${this.baseUrl}${path}`, init)
    const text = await res.text()
    let data: unknown = text
    if (text) {
      try {
        data = JSON.parse(text)
      } catch {
        /* keep raw text */
      }
    } else {
      data = null
    }
    if (!res.ok) throw new ApiError(res.status, data)
    return { status: res.status, data: data as T }
  }

  get<T = unknown>(path: string) {
    return this.request<T>('GET', path)
  }

  post<T = unknown>(path: string, body?: unknown) {
    return this.request<T>('POST', path, body ?? {})
  }
}

export function createClientFromEnv(): AdminClient {
  const basicAuth = process.env.ADMIN_BASIC_AUTH
  if (!basicAuth || !basicAuth.includes(':')) {
    throw new Error(
      'ADMIN_BASIC_AUTH is not set (or not user:password).\n' +
        'relayctl is meant to run inside the relay container, where that env var is already injected.',
    )
  }
  const port = process.env.RELAY_ADMIN_PORT || '8081'
  const baseUrl = process.env.RELAY_ADMIN_URL || `http://127.0.0.1:${port}`
  return new AdminClient({ baseUrl, basicAuth })
}
