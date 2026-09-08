import { PlugsConnectedIcon, WarningIcon } from '@phosphor-icons/react'
import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useSketch } from '../context/SketchContext'
import { useTheme } from '../context/ThemeContext'
import { fetchJson } from '../lib/api'

type ConnectionsReport = {
  parts: Array<{ title: string; moduleIdRef: string }>
  connections: Array<{ from: string; to: string; color: string; segments: number }>
  floating: string[]
  wireSegments: number
}

export default function Connections() {
  const { currentSketch } = useSketch()
  const { theme } = useTheme()
  const [report, setReport] = useState<ConnectionsReport>()
  const [error, setError] = useState<string>()

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
          <span className={`text-sm ${theme.tint.muted}`}>
            {report.connections.length} connections · {report.wireSegments} wire segments
          </span>
        )}
      </div>

      {error && (
        <div className={`mb-4 flex items-center gap-2 rounded-lg border px-4 py-3 text-sm ${theme.tint.warning}`}>
          <WarningIcon size={18} weight="fill" />
          {error}
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
