// Dot-notation paths into JSON documents: "batchId", "batch.id", "transactions.*.id".
// A `*` segment fans out over every array element (or object value) and the result is
// the array of matches.

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json }

export function getAtPath(doc: Json, path: string): Json | undefined {
  return getSegments(doc, path.split('.'))
}

function getSegments(node: Json, segments: string[]): Json | undefined {
  if (segments.length === 0) return node
  const [head, ...rest] = segments
  if (node === null || typeof node !== 'object') return undefined
  if (head === '*') {
    const children = Array.isArray(node) ? node : Object.values(node)
    const out = children
      .map((c) => getSegments(c, rest))
      .filter((v): v is Json => v !== undefined)
    return out
  }
  const child = Array.isArray(node)
    ? node[Number(head)]
    : (node as { [k: string]: Json })[head!]
  return child === undefined ? undefined : getSegments(child, rest)
}

/** All leaf paths of a document, dot-notation — used for the "not forwarded" report. */
export function leafPaths(doc: Json, prefix = ''): string[] {
  if (doc === null || typeof doc !== 'object') return prefix ? [prefix] : []
  const entries = Array.isArray(doc)
    ? doc.map((v, i) => [String(i), v] as const)
    : Object.entries(doc)
  if (entries.length === 0) return prefix ? [prefix] : []
  return entries.flatMap(([k, v]) => leafPaths(v, prefix ? `${prefix}.${k}` : k))
}
