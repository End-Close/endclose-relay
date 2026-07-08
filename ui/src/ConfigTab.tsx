import { useEffect, useState } from 'react'
import {
  fetchConfig,
  fetchConfigVersion,
  fetchConfigVersions,
  previewConfig,
  saveConfig,
  validateConfig,
  type ConfigVersion,
  type PreviewResult,
  type ValidationResult,
} from './api.js'
import { fmtAgo } from './format.js'

// Declarative config, DB-authoritative: this tab edits the YAML, validates against the
// schema, previews the exact outbound record for a sample payload, and saves a new
// config version. Secrets never appear here — the YAML references env-var names only.

export default function ConfigTab() {
  const [yaml, setYaml] = useState('')
  const [activeHash, setActiveHash] = useState('')
  const [dirty, setDirty] = useState(false)
  const [validation, setValidation] = useState<ValidationResult | null>(null)
  const [saveMsg, setSaveMsg] = useState<string | null>(null)
  const [versions, setVersions] = useState<ConfigVersion[]>([])
  const [previewRoute, setPreviewRoute] = useState('')
  const [sampleText, setSampleText] = useState('')
  const [preview, setPreview] = useState<PreviewResult | null>(null)

  const reload = () => {
    fetchConfig().then((c) => {
      setYaml(c.yaml)
      setActiveHash(c.hash)
      setDirty(false)
      setValidation(null)
      setSaveMsg(null)
    })
    fetchConfigVersions().then(setVersions)
  }
  useEffect(reload, [])

  const onValidate = async () => setValidation(await validateConfig(yaml))

  const onSave = async () => {
    const v = await validateConfig(yaml)
    setValidation(v)
    if (!v.valid) return
    if (!confirm('Apply this configuration? Route changes take effect immediately.')) return
    try {
      const res = await saveConfig(yaml)
      setSaveMsg(
        `applied ${res.applied.slice(0, 19)}…` +
          (res.restart_pending ? ' — non-route changes need a container restart' : ''),
      )
      reload()
    } catch (err) {
      setSaveMsg(`save failed: ${(err as Error).message}`)
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
    setSaveMsg(`loaded version #${id} into the editor — review and Apply to restore`)
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

  return (
    <div>
      <p className="text-dim">
        active config: <code className="text-xs">{activeHash.slice(0, 19)}…</code>
        {dirty && <span className="text-warn"> (editor has unsaved changes)</span>}
      </p>

      <textarea
        className="panel min-h-96 resize-y"
        spellCheck={false}
        value={yaml}
        onChange={(e) => {
          setYaml(e.target.value)
          setDirty(true)
          setValidation(null)
        }}
      />

      <div className="my-4 flex items-center gap-3">
        <button onClick={onValidate}>validate</button>
        <button onClick={onSave} disabled={!dirty}>apply</button>
        <button onClick={download}>download yaml</button>
        {saveMsg && <span className="text-dim">{saveMsg}</span>}
      </div>

      {validation &&
        (validation.valid ? (
          <p className="text-ok">
            ✓ valid · hash {validation.hash?.slice(0, 19)}… · routes: {validation.routes?.join(', ')}
            <br />
            <span className="text-dim">
              secrets:{' '}
              {validation.secret_envs?.map((s) => `${s.set ? '✓' : '○'} ${s.name}`).join('  ')}
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
                ) : (
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
