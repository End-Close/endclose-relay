import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

export function die(message: string, code = 1): never {
  console.error(`relayctl: ${message}`)
  process.exit(code)
}

export function printJson(data: unknown): void {
  console.log(JSON.stringify(data, null, 2))
}

/** Read a YAML document from a path, or stdin when path is "-" / undefined with piped stdin. */
export function readYamlInput(path: string | undefined): string {
  if (path && path !== '-') {
    try {
      return readFileSync(path, 'utf8')
    } catch (err) {
      die(`cannot read ${path}: ${(err as Error).message}`)
    }
  }
  // Explicit "-" or omitted when stdin is a pipe
  if (path === '-' || (!path && !process.stdin.isTTY)) {
    return readFileSync(0, 'utf8')
  }
  die('YAML path required (file, or "-" for stdin)')
}

export function writeOutput(path: string | undefined, content: string): void {
  if (!path || path === '-') {
    process.stdout.write(content.endsWith('\n') ? content : content + '\n')
    return
  }
  writeFileSync(path, content.endsWith('\n') ? content : content + '\n')
  console.error(`wrote ${path}`)
}

/** Open $EDITOR on content; return the saved buffer (or null if unchanged cancel — we always return saved). */
export function editInEditor(initial: string, filenameHint = 'relay.yaml'): string {
  const editor = process.env.EDITOR || process.env.VISUAL
  if (!editor) {
    die('set EDITOR (or VISUAL) to use `config edit`, e.g. EDITOR=vi relayctl config edit')
  }
  const dir = mkdtempSync(join(tmpdir(), 'relayctl-'))
  const file = join(dir, filenameHint)
  writeFileSync(file, initial.endsWith('\n') ? initial : initial + '\n')
  const result = spawnSync(editor, [file], { stdio: 'inherit', shell: false })
  if (result.status !== 0) {
    die(`editor exited with status ${result.status ?? 'signal ' + result.signal}`)
  }
  return readFileSync(file, 'utf8')
}

/** Parse `key=value` style flags from argv; returns { flags, rest }. */
export function parseFlags(
  argv: string[],
  known: string[],
): { flags: Record<string, string | boolean>; rest: string[] } {
  const flags: Record<string, string | boolean> = {}
  const rest: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === '--') {
      rest.push(...argv.slice(i + 1))
      break
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=')
      const name = eq === -1 ? a.slice(2) : a.slice(2, eq)
      if (!known.includes(name)) die(`unknown flag --${name}`)
      if (eq !== -1) {
        flags[name] = a.slice(eq + 1)
      } else {
        const next = argv[i + 1]
        if (next && !next.startsWith('--')) {
          flags[name] = next
          i++
        } else {
          flags[name] = true
        }
      }
      continue
    }
    rest.push(a)
  }
  return { flags, rest }
}

export function flagString(flags: Record<string, string | boolean>, name: string): string | undefined {
  const v = flags[name]
  if (v === undefined || v === true) return undefined
  return String(v)
}
