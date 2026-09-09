import { useEffect, useState } from 'react'
import {
  fetchConfig,
  fetchConfigVersion,
  fetchConfigVersions,
  fetchStatus,
  previewConfig,
  saveConfig,
  validateConfig,
  type ConfigVersion,
  type PreviewResult,
  type RemoteConfigStatus,
  type ValidationResult,
} from './api.js'
import { fmtAgo } from './format.js'

// Editor starter for a fresh application (bootstrap mode) — a commented skeleton, not a
// working config: every value below is customer-specific and reviewed with End Close.
const STARTER_YAML = `# endclose-relay configuration — routes only; see docs/CONFIG.md.
# (The End Close endpoint, ports, and tuning are environment settings, not config.)
routes:
  - id: payabli-settlements
    source: payabli
    auth:
      mode: static_header
      header: authorization
      secret_env: PAYABLI_WEBHOOK_SECRET
      allowed_ips: ["54.166.54.170"] # Payabli production (sandbox: 52.3.204.115)
    events: ["TransferFunded"]
    map:
      data_stream_key: payabli_settlements_funded
      external_id: transferId
      amount: NetAmount
      direction: credit
      date: { source: transferTime, format: mdy_hms }
      metadata:
        batch_id: batchId
        batch_number: batchNumber
`

// Declarative config, DB-authoritative: this tab edits the YAML, validates against the
// schema, previews the exact outbound record for a sample payload, and saves a new
// config version. Secrets never appear here — the YAML references env-var names only.

// `remote`: who owns the configuration. While End Close does, the document is shown,
// validated and previewed as usual but not edited here — changes are made in End Close
// and arrive within a minute as new versions. `configHash` is the active hash from the
// status poll: when it changes underneath (a version applied from End Close), reload.
export default function ConfigTab({
  remote = null,
  configHash = null,
}: {
  remote?: RemoteConfigStatus | null
  configHash?: string | null
}) {
  const locked = remote?.managed === true
  const [yaml, setYaml] = useState('')
  const [activeHash, setActiveHash] = useState('')
  const [dirty, setDirty] = useState(false)
  const [validation, setValidation] = useState<ValidationResult | null>(null)
  const [saveMsg, setSaveMsg] = useState<{ text: string; error?: boolean } | null>(null)
  const [versions, setVersions] = useState<ConfigVersion[]>([])
  const [previewRoute, setPreviewRoute] = useState('')
  const [sampleText, setSampleText] = useState('')
  const [preview, setPreview] = useState<PreviewResult | null>(null)
  const [restarting, setRestarting] = useState<false | 'plain' | 'paused'>(false)

  const reload = () => {
    fetchConfig().then(
      (c) => {
        setYaml(c.yaml)
        setActiveHash(c.hash ?? '')
        if (c.error) {
          // Stored document fails validation (e.g. schema changed across an upgrade):
          // preload it for repair and show the error where validate results appear.
          setDirty(true)
          setValidation({ valid: false, error: c.error })
        } else {
          setDirty(false)
          setValidation(null)
        }
        setSaveMsg(null)
      },
      () => {
        // No config yet (bootstrap mode): start the editor from the skeleton.
        setYaml((prev) => prev || STARTER_YAML)
        setActiveHash('')
        setDirty(true)
      },
    )
    fetchConfigVersions().then(setVersions, () => setVersions([]))
  }
  useEffect(reload, [])
  useEffect(() => {
    // A new version arrived from End Close (or another admin session): refresh unless
    // the operator is mid-edit on an unlocked editor.
    if (configHash && activeHash && configHash !== activeHash && (locked || !dirty)) reload()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configHash])

  const onValidate = async () => setValidation(await validateConfig(yaml))

  /** After a bootstrap apply the process restarts itself; poll until it's back. */
  const waitForRunning = async (paused: boolean) => {
    setRestarting(paused ? 'paused' : 'plain')
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 1000))
      try {
        const s = await fetchStatus()
        if (s.mode === 'running') {
          location.reload()
          return
        }
      } catch {
        // process is down mid-restart — keep polling
      }
    }
    setRestarting(false)
    setSaveMsg({ text: 'relay did not come back within 60s — check the container on the host', error: true })
  }

  const onSave = async () => {
    const v = await validateConfig(yaml)
    setValidation(v)
    if (!v.valid) return
    if (!confirm('Apply this configuration? Route changes take effect immediately.')) return
    try {
      const res = await saveConfig(yaml)
      if (res.restarting) {
        setSaveMsg({ text: `applied ${res.applied.slice(0, 19)}… — relay is restarting into running mode` })
        void waitForRunning(res.paused ?? false)
        return
      }
      setSaveMsg({ text: `applied ${res.applied.slice(0, 19)}… — live` })
      reload()
    } catch (err) {
      setSaveMsg({ text: `save failed: ${(err as Error).message}`, error: true })
    }
  }

  const onPreview = async () => {
    let sample: unknown
    try {
      sample = JSON.parse(sampleText)
    } catch {
      setPreview({ error: 'sample is not valid JSON' })
      return
    }
    try {
      setPreview(await previewConfig(yaml, previewRoute, sample))
    } catch (err) {
      setPreview({ error: (err as Error).message })
    }
  }

  const restoreVersion = async (id: number) => {
    const v = await fetchConfigVersion(id)
    setYaml(v.config_yaml)
    setDirty(true)
    setValidation(null)
    setSaveMsg({ text: `loaded version #${id} into the editor — review and Apply to restore` })
  }

  const download = () => {
    const blob = new Blob([yaml], { type: 'application/yaml' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = 'relay.yaml'
    a.click()
    URL.revokeObjectURL(a.href)
  }

  const routeIds = validation?.routes ?? []

  if (restarting) {
    return (
      <p className="my-8 text-center text-warn">
        configuration applied — the relay is restarting into running mode…
        {restarting === 'paused' && (
          <span className="mt-2 block">
            Forwarding will be <strong>paused</strong> so you can review the repaired
            config before the buffered backlog drains — resume from the status tab.
          </span>
        )}
      </p>
    )
  }

  return (
    <div>
      {locked && remote && (
        <p className="env-warning">
          <strong>Managed by End Close</strong>
          {remote.environment ? ` (environment: ${remote.environment})` : ''} — this configuration is
          edited in End Close and reaches the relay within a minute. The editor below is read-only;
          validate, preview and download still work.
          {remote.last_confirmed_at && (
            <span className="text-dim"> Last confirmed {fmtAgo(remote.last_confirmed_at)}.</span>
          )}
        </p>
      )}
      {remote?.state === 'failed' && (
        <p className="env-warning">
          <strong>End Close could not be reached for the configuration</strong> — {remote.error}.{' '}
          {remote.retrying
            ? 'The relay keeps asking every minute and runs the configuration it has meanwhile.'
            : 'Fix the cause (a secret env var named by the configuration, the API key, or the document in End Close); the relay keeps asking every minute.'}
        </p>
      )}
      <p className="text-dim">
        active config:{' '}
        <code className="text-xs">{activeHash ? `${activeHash.slice(0, 19)}…` : '(none yet)'}</code>
        {dirty && !locked && <span className="text-warn"> (editor has unsaved changes)</span>}
      </p>

      <textarea
        className="panel min-h-96 resize-y"
        spellCheck={false}
        readOnly={locked}
        value={yaml}
        onChange={(e) => {
          if (locked) return
          setYaml(e.target.value)
          setDirty(true)
          setValidation(null)
        }}
      />

      <div className="my-4 flex items-center gap-3">
        <button onClick={onValidate}>validate</button>
        {!locked && <button onClick={onSave} disabled={!dirty}>apply</button>}
        <button onClick={download}>download yaml</button>
        {saveMsg && (
          <span className={saveMsg.error ? 'font-bold text-bad' : 'text-dim'}>{saveMsg.text}</span>
        )}
      </div>

      {validation &&
        (validation.valid ? (
          <p className="text-ok">
            ✓ valid · hash {validation.hash?.slice(0, 19)}… · routes: {validation.routes?.join(', ')}
            <br />
            <span className="text-dim">
              secrets:{' '}
              {validation.secret_envs?.map((s) => (
                <span key={s.name} className={s.set ? '' : 'mr-2 font-bold text-bad'}>
                  {s.set ? `✓ ${s.name}` : `✗ ${s.name} (unset)`}{' '}
                </span>
              ))}
            </span>
          </p>
        ) : (
          <pre className="panel overflow-x-auto whitespace-pre text-bad">{validation.error}</pre>
        ))}

      <h2>map preview</h2>
      <p className="text-dim">
        Paste a sample webhook payload to see the exact record that would leave your network
        under the YAML above (saved or not). Runs locally; sends nothing.
      </p>
      <div className="my-4 flex items-center gap-3">
        <label className="text-dim">
          route{' '}
          <select value={previewRoute} onChange={(e) => setPreviewRoute(e.target.value)}>
            <option value="">choose…</option>
            {routeIds.map((r) => (
              <option key={r} value={r}>{r}</option>
            ))}
          </select>
        </label>
        {routeIds.length === 0 && <span className="text-dim">run validate to list routes</span>}
        <button onClick={onPreview} disabled={!previewRoute || !sampleText}>preview</button>
      </div>
      <textarea
        className="panel min-h-32 resize-y"
        placeholder='{"Event": "TransferFunded", ...}'
        spellCheck={false}
        value={sampleText}
        onChange={(e) => setSampleText(e.target.value)}
      />
      {preview &&
        (preview.error ? (
          <pre className="panel overflow-x-auto whitespace-pre text-bad">{preview.error}</pre>
        ) : (
          <pre className="panel overflow-x-auto whitespace-pre">{JSON.stringify(preview, null, 2)}</pre>
        ))}

      <h2>history</h2>
      <table>
        <thead>
          <tr><th>#</th><th>applied</th><th>by</th><th>hash</th><th></th></tr>
        </thead>
        <tbody>
          {versions.map((v) => (
            <tr key={v.id}>
              <td>{v.id}</td>
              <td>{fmtAgo(v.applied_at)}</td>
              <td>{v.applied_by}</td>
              <td><code className="text-xs text-dim">{v.config_hash.slice(0, 19)}…</code></td>
              <td>
                {v.config_hash === activeHash ? (
                  <span className="pill text-ok">active</span>
                ) : locked ? null : (
                  <button onClick={() => restoreVersion(v.id)}>load</button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
