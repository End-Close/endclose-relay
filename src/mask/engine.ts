import { createHmac } from 'node:crypto'
import type { MaskConfig } from '../config/schema.js'
import { hardDenyValue, keyNameIsSensitive } from './defaults.js'
import { parsePointer, matchesOrIsUnder, pointerToString, type Json } from './paths.js'

export const REDACTED = '[REDACTED]'

export interface MaskReport {
  kept: string[]
  dropped: string[]
  hashed: string[]
  redacted: string[]
  hard_denied: string[]
}

export interface MaskResult {
  output: Json
  report: MaskReport
}

interface CompiledRules {
  mode: 'allowlist' | 'denylist'
  allow: string[][]
  drops: string[][]
  hashes: string[][]
  redacts: string[][]
}

function compile(rules: MaskConfig): CompiledRules {
  return {
    mode: rules.mode,
    allow: rules.allow.map(parsePointer),
    drops: rules.transforms.filter((t) => t.action === 'drop').map((t) => parsePointer(t.path)),
    hashes: rules.transforms.filter((t) => t.action === 'hash').map((t) => parsePointer(t.path)),
    redacts: rules.transforms.filter((t) => t.action === 'redact').map((t) => parsePointer(t.path)),
  }
}

function hashValue(hmacKey: Buffer, value: Json): string {
  const raw = typeof value === 'string' ? value : JSON.stringify(value)
  return 'hmac256:' + createHmac('sha256', hmacKey).update(raw, 'utf8').digest('hex')
}

/**
 * Pure masking function. Precedence, most to least binding:
 *   1. drop transforms — value never leaves, not even masked
 *   2. redact / hash transforms — value leaves in masked form
 *   3. allowlist / denylist mode decides everything else
 * The hard denylist (defaults.ts) then runs over whatever survived, in every mode.
 */
export function mask(rules: MaskConfig, doc: Json, hmacKey: Buffer): MaskResult {
  const compiled = compile(rules)
  const report: MaskReport = { kept: [], dropped: [], hashed: [], redacted: [], hard_denied: [] }
  const output = walk(compiled, doc, [], report, hmacKey)
  return { output: output === undefined ? null : output, report }
}

function anyMatch(patterns: string[][], path: string[]): boolean {
  return patterns.some((p) => matchesOrIsUnder(p, path))
}

function walk(
  rules: CompiledRules,
  node: Json,
  path: string[],
  report: MaskReport,
  hmacKey: Buffer,
): Json | undefined {
  const here = pointerToString(path)

  if (path.length > 0) {
    if (anyMatch(rules.drops, path)) {
      report.dropped.push(here)
      return undefined
    }
    if (anyMatch(rules.redacts, path)) {
      report.redacted.push(here)
      return REDACTED
    }
    if (anyMatch(rules.hashes, path)) {
      report.hashed.push(here)
      return hashValue(hmacKey, node)
    }
  }

  if (node !== null && typeof node === 'object') {
    if (Array.isArray(node)) {
      const out: Json[] = []
      for (let i = 0; i < node.length; i++) {
        const child = walk(rules, node[i] as Json, [...path, String(i)], report, hmacKey)
        if (child !== undefined) out.push(child)
      }
      return out.length > 0 || keepContainer(rules, path) ? out : undefined
    }
    const out: { [k: string]: Json } = {}
    let any = false
    for (const [k, v] of Object.entries(node)) {
      const childPath = [...path, k]
      if (keyNameIsSensitive(k)) {
        // Hard denylist on key names applies in every mode and cannot be configured away.
        report.hard_denied.push(pointerToString(childPath))
        continue
      }
      const child = walk(rules, v, childPath, report, hmacKey)
      if (child !== undefined) {
        out[k] = child
        any = true
      }
    }
    return any || keepContainer(rules, path) ? out : undefined
  }

  // Scalar leaf: mode decides.
  if (rules.mode === 'allowlist' && path.length > 0 && !allowedLeaf(rules, path)) {
    report.dropped.push(here)
    return undefined
  }

  if (typeof node === 'string') {
    const denied = hardDenyValue(node)
    if (denied !== node) {
      report.hard_denied.push(here)
      report.kept.push(here)
      return denied
    }
  }
  report.kept.push(here)
  return node
}

/** In allowlist mode, a leaf survives when its path sits at or under an allow pattern. */
function allowedLeaf(rules: CompiledRules, path: string[]): boolean {
  return rules.allow.some((pattern) => matchesOrIsUnder(pattern, path))
}

/** Containers named by an allow pattern stay present (as {} / []) even if emptied. */
function keepContainer(rules: CompiledRules, path: string[]): boolean {
  if (path.length === 0) return true
  if (rules.mode === 'denylist') return true
  return rules.allow.some(
    (pattern) => pattern.length === path.length && matchesOrIsUnder(pattern, path),
  )
}
