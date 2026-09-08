import { CheckIcon, CopyIcon, PlugsConnectedIcon, UploadSimpleIcon, WarningIcon } from '@phosphor-icons/react'
import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useSketch } from '../context/SketchContext'
import { useTheme } from '../context/ThemeContext'
import { fetchJson } from '../lib/api'

type ConnectionsReport = {
  parts: Array<{ title: string; moduleIdRef: string }>
  connections: Array<{ from: string; to: string; fromRef: string; toRef: string; color: string; segments: number }>
  floating: string[]
  wireSegments: number
}

export default function Connections() {
  const { currentSketch } = useSketch()
  const { theme } = useTheme()
  const [report, setReport] = useState<ConnectionsReport>()
  const [error, setError] = useState<string>()
  const [copied, setCopied] = useState(false)
  const [jsonText, setJsonText] = useState('')
  const [applying, setApplying] = useState(false)
  const [applied, setApplied] = useState<number>()

  const load = useCallback(() => {
    if (!currentSketch) return
    fetchJson<ConnectionsReport>(`/api/sketch/connections?path=${encodeURIComponent(currentSketch)}`)
      .then(data => {
        setReport(data)
        setError(undefined)
      })
      .catch((requestError: Error) => setError(requestError.message))
  }, [currentSketch])

  useEffect(load, [load])

  const editableJson = () =>
    JSON.stringify(
      { connections: (report?.connections ?? []).map(c => ({ from: c.fromRef, to: c.toRef, color: c.color })) },
      null,
      2
    )

  const copyJson = () => {
    navigator.clipboard.writeText(editableJson()).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }

  const applyJson = () => {
    if (!currentSketch || !jsonText.trim()) return
    setApplying(true)
    setApplied(undefined)
    fetchJson<{ applied: number }>(`/api/sketch/connections?path=${encodeURIComponent(currentSketch)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: jsonText
    })
      .then(result => {
        setApplied(result.applied)
        setError(undefined)
        setJsonText('')
        load()
      })
      .catch((requestError: Error) => setError(requestError.message))
      .finally(() => setApplying(false))
  }

  if (!currentSketch) {
    return (
      <section>
        <h2 className="mb-3 text-lg font-medium">Connections</h2>
        <p className={`text-sm ${theme.tint.faint}`}>
          No sketch selected. Pick one on the{' '}
          <Link to="/" className={theme.primary.link}>
            Sketches page
          </Link>
          .
        </p>
      </section>
    )
  }

  return (
    <section>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="flex items-center gap-2 text-lg font-medium">
          <PlugsConnectedIcon size={22} className={theme.primary.icon} />
          Connections
        </h2>
        {report && (
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={copyJson}
              className={`flex items-center gap-2 rounded-lg border ${theme.secondary.border} px-3 py-2 text-sm transition ${theme.primary.hoverBorder}`}
            >
              {copied ? <CheckIcon size={16} /> : <CopyIcon size={16} />}
              {copied ? 'Copied' : 'Copy JSON'}
            </button>
            <span className={`text-sm ${theme.tint.muted}`}>
              {report.connections.length} connections · {report.wireSegments} wire segments
            </span>
          </div>
        )}
      </div>

      {error && (
        <div className={`mb-4 flex items-start gap-2 rounded-lg border px-4 py-3 text-sm ${theme.tint.warning}`}>
          <WarningIcon size={18} weight="fill" className="mt-0.5 shrink-0" />
          <pre className="whitespace-pre-wrap font-sans">{error}</pre>
        </div>
      )}

      {applied !== undefined && (
        <div className={`mb-4 rounded-lg border ${theme.secondary.border} px-4 py-3 text-sm`}>
          Applied {applied} connections — the sketch was rewired (backup saved).
        </div>
      )}

      {report && (
        <>
          <ul className="space-y-2">
            {report.connections.map((connection, index) => (
              <li key={index} className={`flex items-center gap-3 rounded-xl border ${theme.secondary.borderSoft} ${theme.secondary.surface} px-4 py-3`}>
                <span className="h-3 w-3 shrink-0 rounded-full border border-black/20" style={{ backgroundColor: connection.color }} />
                <span className="min-w-0 flex-1 truncate text-sm">
                  {connection.from} <span className={theme.tint.faint}>→</span> {connection.to}
                </span>
                <span className={`shrink-0 text-xs ${theme.tint.faint}`}>
                  {connection.segments} seg{connection.segments === 1 ? '' : 's'}
                </span>
              </li>
            ))}
            {report.connections.length === 0 && (
              <li className={`text-sm ${theme.tint.faint}`}>No wire connections in this sketch.</li>
            )}
          </ul>

          {report.floating.length > 0 && (
            <div className={`mt-4 rounded-lg border px-4 py-3 text-sm ${theme.tint.warning}`}>
              Floating wires: {report.floating.join(', ')}
            </div>
          )}

          <h3 className="mb-2 mt-6 text-sm font-medium">Edit as JSON</h3>
          <textarea
            value={jsonText}
            onChange={event => setJsonText(event.target.value)}
            placeholder='Paste a connections JSON here, e.g. { "connections": [{ "from": "PIR1:connector2", "to": "ArduinoUno:connector63", "color": "#33cc00" }] }'
            rows={6}
            className={`w-full rounded-lg border ${theme.secondary.input} px-3 py-2 font-mono text-xs outline-none ${theme.primary.focusBorder}`}
          />
          <button
            type="button"
            onClick={applyJson}
            disabled={applying || !jsonText.trim()}
            className={`mt-2 flex items-center gap-2 rounded-lg ${theme.primary.button} px-4 py-2 text-sm font-medium transition disabled:opacity-50`}
          >
            <UploadSimpleIcon size={18} />
            {applying ? 'Applying…' : 'Validate and apply'}
          </button>

          <h3 className="mb-2 mt-6 text-sm font-medium">Parts ({report.parts.length})</h3>
          <ul className="space-y-1">
            {report.parts.map((part, index) => (
              <li key={index} className={`text-sm ${theme.tint.muted}`}>
                {part.title} <span className={`font-mono text-xs ${theme.tint.faint}`}>[{part.moduleIdRef}]</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  )
}
