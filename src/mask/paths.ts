// JSON-Pointer-style paths with `*` wildcards. A path like /transactions/*/Id matches
// any array index or object key at the wildcard position.

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json }

export function parsePointer(pointer: string): string[] {
  if (!pointer.startsWith('/')) throw new Error(`invalid pointer: ${pointer}`)
  return pointer
    .slice(1)
    .split('/')
    .map((s) => s.replaceAll('~1', '/').replaceAll('~0', '~'))
}

export function pointerToString(segments: string[]): string {
  return '/' + segments.map((s) => s.replaceAll('~', '~0').replaceAll('/', '~1')).join('/')
}

export function segmentsMatch(pattern: string[], path: string[]): boolean {
  if (pattern.length !== path.length) return false
  return pattern.every((p, i) => p === '*' || p === path[i])
}

/** True when `path` is `pattern` itself or lies underneath it. */
export function matchesOrIsUnder(pattern: string[], path: string[]): boolean {
  if (path.length < pattern.length) return false
  return pattern.every((p, i) => p === '*' || p === path[i])
}

/** Get the value at a concrete (wildcard-free) pointer; undefined when absent. */
export function getAtPointer(doc: Json, pointer: string): Json | undefined {
  let cur: Json | undefined = doc
  for (const seg of parsePointer(pointer)) {
    if (cur === null || typeof cur !== 'object') return undefined
    cur = Array.isArray(cur) ? cur[Number(seg)] : (cur as { [k: string]: Json })[seg]
    if (cur === undefined) return undefined
  }
  return cur
}
