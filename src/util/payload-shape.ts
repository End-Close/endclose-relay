import type { Json } from '../mask/paths.js'

/** Comma-sorted top-level keys of a JSON object — safe for logs (no values). */
export function jsonTopLevelKeys(value: Json | unknown): string {
  if (value === null || typeof value !== 'object') return typeof value
  if (Array.isArray(value)) return '(array)'
  return Object.keys(value).sort().join(',')
}

/** Comma-sorted request header names, excluding auth/secret headers. */
export function requestHeaderNames(headers: Record<string, unknown>): string {
  return Object.keys(headers)
    .filter((h) => {
      const n = h.toLowerCase()
      return n !== 'authorization' && !n.includes('secret') && !n.includes('api-key')
    })
    .sort()
    .join(',')
}
