import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

// Detect whether the data directory is backed by real storage or by the container's
// ephemeral writable layer. Rationale: on Docker/Kubernetes without a volume mounted at
// the data path, everything (config, buffered events, audit) is silently lost on
// container restart — and the bootstrap flow *ends* in a restart, so an operator would
// apply their config and watch it vanish. The admin UI warns instead.
//
// Heuristic: find the mount that contains the data directory in /proc/self/mountinfo.
// If that mount is the container's root overlayfs, nothing persistent is attached; a
// Docker named volume / K8s PV / bind mount appears as its own (non-overlay) mount.

export type Persistence = boolean | null // null = undeterminable (no /proc, :memory:)

export function isDbPathPersistent(dbPath: string): Persistence {
  if (dbPath === ':memory:') return null
  let mountinfo: string
  try {
    mountinfo = readFileSync('/proc/self/mountinfo', 'utf8')
  } catch {
    return null // not Linux (dev on macOS) — no claim either way
  }
  return parseMountPersistence(mountinfo, dirname(resolve(dbPath)))
}

export function parseMountPersistence(mountinfo: string, dir: string): Persistence {
  // mountinfo fields: id parent major:minor root MOUNTPOINT options... - FSTYPE source ...
  let best: { mountPoint: string; fstype: string } | undefined
  for (const line of mountinfo.split('\n')) {
    if (!line) continue
    const sep = line.indexOf(' - ')
    if (sep < 0) continue
    const head = line.slice(0, sep).split(' ')
    const tail = line.slice(sep + 3).split(' ')
    const mountPoint = head[4]
    const fstype = tail[0]
    if (!mountPoint || !fstype) continue
    const decoded = decodeMountPath(mountPoint)
    if (dir === decoded || dir.startsWith(decoded.endsWith('/') ? decoded : decoded + '/')) {
      if (!best || decoded.length > best.mountPoint.length) {
        best = { mountPoint: decoded, fstype }
      }
    }
  }
  if (!best) return null
  return best.fstype !== 'overlay'
}

/** mountinfo escapes space/tab/newline/backslash as octal (e.g. \040). */
function decodeMountPath(p: string): string {
  return p.replace(/\\(\d{3})/g, (_, oct: string) => String.fromCharCode(parseInt(oct, 8)))
}
