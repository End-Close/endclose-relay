import { useEffect, useState } from 'react'
import {
  fetchAudit,
  fetchEvents,
  fetchStatus,
  replayAllParked,
  replayEvent,
  setKillswitch,
  setRoutePaused,
  type AuditRow,
  type EventSummary,
  type Status,
} from './api.js'
import ConfigTab from './ConfigTab.js'
import { fmtAgo, fmtBytes, fmtDuration, fmtTime } from './format.js'

const REFRESH_MS = 5000

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      className="px-1.5 py-0 text-xs"
      title={`copy ${text}`}
      onClick={() => {
        void navigator.clipboard.writeText(text)
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      }}
    >
      {copied ? 'copied ✓' : 'copy'}
    </button>
  )
}

/** Poll a fetcher while its consumer is mounted; null until the first response. */
function usePolled<T>(fetcher: () => Promise<T>, deps: unknown[]): { data: T | null; error: string | null; refresh: () => void } {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [nonce, setNonce] = useState(0)
  useEffect(() => {
    let live = true
    const tick = () =>
      fetcher().then(
        (d) => live && (setData(d), setError(null)),
        (e: Error) => live && setError(e.message),
      )
    tick()
    const timer = setInterval(tick, REFRESH_MS)
    return () => {
      live = false
      clearInterval(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce])
  return { data, error, refresh: () => setNonce((n) => n + 1) }
}

function KillswitchControls({ status, refresh }: { status: Status; refresh: () => void }) {
  const ks = status.killswitch.global
  const flip = async (state: 'none' | 'pause' | 'panic', warning?: string) => {
    if (warning && !confirm(warning)) return
    await setKillswitch(state)
    refresh()
  }
  return (
    <span className="inline-flex items-center gap-1.5">
      {ks === 'none' ? (
        <span className="pill text-ok">forwarding</span>
      ) : (
        <span className={`pill ${ks === 'panic' ? 'text-bad' : 'text-warn'}`}>killswitch: {ks}</span>
      )}{' '}
      {ks === 'none' && (
        <>
          <button onClick={() => flip('pause', 'Pause forwarding? Webhooks keep buffering locally; nothing is lost.')}>
            pause
          </button>
          <button
            className="text-bad"
            onClick={() =>
              flip(
                'panic',
                'PANIC: refuse all incoming webhooks (503) and stop forwarding?\n\nThe processor only retries for a limited window — an extended panic can require manual replay from the processor. Continue?',
              )
            }
          >
            panic
          </button>
        </>
      )}
      {ks !== 'none' && <button onClick={() => flip('none')}>resume</button>}
    </span>
  )
}

function RoutesTable({ status, refresh }: { status: Status; refresh: () => void }) {
  const togglePause = async (id: string, paused: boolean) => {
    if (!paused || confirm(`Pause route ${id}? Its events keep buffering; nothing is forwarded.`)) {
      await setRoutePaused(id, paused)
      refresh()
    }
  }
  return (
    <table>
      <thead>
        <tr>
          <th>route</th><th>stream</th><th>state</th><th>pending</th><th>retry</th>
          <th>parked</th><th>delivered</th><th>oldest pending</th><th>last delivered</th><th></th>
        </tr>
      </thead>
      <tbody>
        {status.routes.map((r) => (
          <tr key={r.id}>
            <td>
              {r.id}
              <span className="mt-0.5 flex items-center gap-1.5 text-xs text-dim">
                <code>/ingest/{r.id}</code>
                <CopyButton text={`/ingest/${r.id}`} />
              </span>
            </td>
            <td>{r.data_stream_key}</td>
            <td>{r.paused ? <span className="text-warn">paused</span> : 'active'}</td>
            <td>{r.counts.pending ?? 0}</td>
            <td>{r.counts.retry ?? 0}</td>
            <td className={r.counts.parked ? 'text-bad' : ''}>{r.counts.parked ?? 0}</td>
            <td>{r.counts.delivered ?? 0}</td>
            <td>{r.oldest_pending_age_s == null ? '—' : fmtDuration(r.oldest_pending_age_s)}</td>
            <td title={fmtTime(r.last_delivered_at)}>{fmtAgo(r.last_delivered_at)}</td>
            <td>
              <button onClick={() => togglePause(r.id, !r.paused)}>
                {r.paused ? 'resume' : 'pause'}
              </button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

const EVENT_STATUSES = ['', 'pending', 'retry', 'delivering', 'delivered', 'parked', 'dropped_by_filter']

function EventsTab({ routes }: { routes: string[] }) {
  const [status, setStatus] = useState('')
  const [route, setRoute] = useState('')
  const { data, error, refresh } = usePolled(
    () => fetchEvents({ ...(status && { status }), ...(route && { route }) }),
    [status, route],
  )
  const parkedCount = (data ?? []).filter((e) => e.status === 'parked').length
  const replayOne = async (id: number) => {
    await replayEvent(id)
    refresh()
  }
  const replayParked = async () => {
    if (!confirm('Re-queue all parked events for delivery?')) return
    const res = await replayAllParked()
    alert(`replayed ${res.replayed} event(s)`)
    refresh()
  }
  return (
    <>
      <div className="my-4 flex items-center gap-3">
        <label className="text-dim">
          status{' '}
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            {EVENT_STATUSES.map((s) => (
              <option key={s} value={s}>{s || 'all'}</option>
            ))}
          </select>
        </label>
        <label className="text-dim">
          route{' '}
          <select value={route} onChange={(e) => setRoute(e.target.value)}>
            <option value="">all</option>
            {routes.map((r) => (
              <option key={r} value={r}>{r}</option>
            ))}
          </select>
        </label>
        {parkedCount > 0 && (
          <button onClick={replayParked}>replay all parked</button>
        )}
        {error && <span className="text-bad">{error}</span>}
      </div>
      <table>
        <thead>
          <tr>
            <th>#</th><th>status</th><th>route</th><th>event</th><th>received</th>
            <th>attempts</th><th>last error</th><th></th>
          </tr>
        </thead>
        <tbody>
          {(data ?? []).map((e: EventSummary) => (
            <tr key={e.id}>
              <td>{e.id}</td>
              <td className={e.status === 'parked' ? 'text-bad' : e.status === 'retry' ? 'text-warn' : ''}>{e.status}</td>
              <td>{e.route_id}</td>
              <td>{e.event_type ?? '?'}</td>
              <td title={fmtTime(e.received_at)}>{fmtAgo(e.received_at)}</td>
              <td>{e.attempts}</td>
              <td className="max-w-96 break-words text-dim">{e.last_error ?? ''}</td>
              <td>{e.status === 'parked' && <button onClick={() => replayOne(e.id)}>replay</button>}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {data?.length === 0 && <div className="py-8 text-center text-dim">no events match</div>}
    </>
  )
}

function AuditTab() {
  const { data, error } = usePolled(() => fetchAudit(), [])
  const download = () => {
    const jsonl = (data ?? []).map((r) => JSON.stringify(r)).join('\n')
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob([jsonl], { type: 'application/jsonl' }))
    a.download = 'relay-audit.jsonl'
    a.click()
    URL.revokeObjectURL(a.href)
  }
  return (
    <>
      <div className="my-4 flex items-center gap-3">
        <button onClick={download}>download jsonl</button>
        {error && <span className="text-bad">{error}</span>}
      </div>
      <table>
        <thead>
          <tr><th>at</th><th>actor</th><th>action</th><th>detail</th></tr>
        </thead>
        <tbody>
          {(data ?? []).map((a: AuditRow) => (
            <tr key={a.id}>
              <td title={fmtTime(a.at)}>{fmtAgo(a.at)}</td>
              <td>{a.actor}</td>
              <td>{a.action}</td>
              <td className="text-dim">{a.detail_json}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {data?.length === 0 && <div className="py-8 text-center text-dim">no audit entries</div>}
    </>
  )
}

const TABS = ['status', 'events', 'config', 'audit'] as const

export default function App() {
  const [tab, setTab] = useState<(typeof TABS)[number]>('status')
  const { data: status, error, refresh } = usePolled(fetchStatus, [])

  if (status?.mode === 'bootstrap') {
    return (
      <>
        <h1>
          endclose-relay <small>v{status.version} — setup</small>
        </h1>
        {status.storage.persistent === false && (
          <p className="env-warning">
            <strong>⚠ No persistent volume detected</strong> — the data directory (
            <code>{status.storage.db_path}</code>) is on the container's ephemeral
            filesystem. Applying a configuration restarts the relay, and{' '}
            <strong>everything will be lost, landing you back on this screen</strong>.
            Attach a volume at that path (Docker volume / Kubernetes PersistentVolume)
            and redeploy before configuring.
          </p>
        )}
        <p className="env-warning">
          The relay is not configured yet. Paste your initial configuration below, use
          validate + map preview with a sample payload, then apply — the relay restarts
          itself into running mode. <strong>No webhooks are accepted until then.</strong>
        </p>
        {status.secret_envs.some((s) => !s.set) && (
          <p className="text-dim">
            note: unset secrets ({status.secret_envs.filter((s) => !s.set).map((s) => s.name).join(', ')})
            can be provided before or after configuration.
          </p>
        )}
        <ConfigTab />
      </>
    )
  }

  return (
    <>
      <h1>
        endclose-relay <small>{status ? `v${status.version}` : ''}</small>
      </h1>
      <p className="mt-1 mb-4 text-dim">
        {error && <span className="text-bad">relay unreachable: {error}</span>}
        {status && (
          <>
            uptime {fmtDuration(status.uptime_s)} · db {fmtBytes(status.storage.db_bytes)} · config{' '}
            <code className="text-xs" title={status.config_hash ?? ''}>
              {(status.config_hash ?? '?').slice(0, 19)}
            </code>
            {' '}· <KillswitchControls status={status} refresh={refresh} />
          </>
        )}
      </p>
      {status && status.storage.persistent === false && (
        <p className="env-warning">
          ⚠ no persistent volume: <code>{status.storage.db_path}</code> is on the
          container's ephemeral filesystem — configuration, buffered events, and audit
          history <strong>will be lost on the next restart</strong>. Attach a volume at
          that path.
        </p>
      )}
      {status && status.secret_envs.some((s) => !s.set) && (
        <p className="env-warning">
          ⚠ missing secrets:{' '}
          {status.secret_envs.filter((s) => !s.set).map((s) => s.name).join(', ')} — the relay
          cannot verify or forward without them. Provide them to the container environment
          and recreate it.
        </p>
      )}
      <nav className="tabs">
        {TABS.map((t) => (
          <button key={t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>
            {t}
          </button>
        ))}
      </nav>
      {tab === 'status' && status && <RoutesTable status={status} refresh={refresh} />}
      {tab === 'events' && <EventsTab routes={status?.routes.map((r) => r.id) ?? []} />}
      {tab === 'config' && <ConfigTab />}
      {tab === 'audit' && <AuditTab />}
    </>
  )
}
