import { ArrowsClockwiseIcon, FileCodeIcon, FolderOpenIcon, WarningIcon } from '@phosphor-icons/react'
import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { useSketch } from '../context/SketchContext'
import { useTheme } from '../context/ThemeContext'
import { fetchJson } from '../lib/api'

export default function Sketches() {
  const [sketches, setSketches] = useState<string[]>([])
  const { currentSketch, setCurrentSketch } = useSketch()
  const { theme } = useTheme()
  const [pathInput, setPathInput] = useState(currentSketch ?? '')
  const [summary, setSummary] = useState<string>()
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)

  const loadSketches = useCallback(() => {
    fetchJson<{ sketches: string[] }>('/api/sketches?limit=100')
      .then(data => {
        setSketches(data.sketches)
        setError(undefined)
      })
      .catch((requestError: Error) => setError(requestError.message))
  }, [])

  useEffect(loadSketches, [loadSketches])

  const selectSketch = (sketch: string) => {
    setCurrentSketch(sketch)
    setPathInput(sketch)
    setSummary(undefined)
    fetchJson<{ summary: string }>(`/api/sketch/summary?path=${encodeURIComponent(sketch)}`)
      .then(data => {
        setSummary(data.summary)
        setError(undefined)
      })
      .catch((requestError: Error) => setError(requestError.message))
  }

  const loadTypedPath = (event: FormEvent) => {
    event.preventDefault()
    const path = pathInput.trim()
    if (path) selectSketch(path)
  }

  const browseForSketch = () => {
    setBusy(true)
    fetchJson<{ path: string | null }>('/api/browse')
      .then(data => {
        if (data.path) selectSketch(data.path)
      })
      .catch((requestError: Error) => setError(requestError.message))
      .finally(() => setBusy(false))
  }

  return (
    <section>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-lg font-medium">Sketches</h2>
        <button
          type="button"
          onClick={loadSketches}
          className={`flex items-center gap-2 rounded-lg border ${theme.secondary.border} px-3 py-2 text-sm transition ${theme.primary.hoverBorder}`}
        >
          <ArrowsClockwiseIcon size={18} />
          Refresh
        </button>
      </div>

      {error && (
        <div className={`mb-4 flex items-center gap-2 rounded-lg border px-4 py-3 text-sm ${theme.tint.warning}`}>
          <WarningIcon size={18} weight="fill" />
          {error}
        </div>
      )}

      <form onSubmit={loadTypedPath} className="mb-4 flex gap-2">
        <input
          value={pathInput}
          onChange={event => setPathInput(event.target.value)}
          placeholder="Type or paste a sketch path (.fz / .fzz)"
          className={`w-full rounded-lg border ${theme.secondary.input} px-3 py-2 text-sm outline-none ${theme.primary.focusBorder}`}
        />
        <button
          type="submit"
          disabled={!pathInput.trim()}
          className={`rounded-lg border ${theme.secondary.border} px-3 py-2 text-sm transition ${theme.primary.hoverBorder} disabled:opacity-50`}
        >
          Load
        </button>
        <button
          type="button"
          onClick={browseForSketch}
          disabled={busy}
          className={`flex items-center gap-2 rounded-lg border ${theme.secondary.border} px-3 py-2 text-sm transition ${theme.primary.hoverBorder} disabled:opacity-50`}
        >
          <FolderOpenIcon size={18} />
          Browse
        </button>
      </form>
      <ul className="space-y-1">
        {sketches.map(sketch => (
          <li key={sketch}>
            <button
              type="button"
              onClick={() => selectSketch(sketch)}
              className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm transition ${theme.secondary.surfaceHover} ${
                sketch === currentSketch ? theme.primary.active : theme.tint.text
              }`}
            >
              <FileCodeIcon size={18} className={`shrink-0 ${theme.primary.icon}`} />
              <span className="truncate">{sketch}</span>
            </button>
          </li>
        ))}
        {sketches.length === 0 && !error && <li className={`text-sm ${theme.tint.faint}`}>No sketches found.</li>}
      </ul>
      {summary && (
        <pre className={`mt-4 overflow-auto rounded-xl border ${theme.secondary.borderSoft} ${theme.secondary.surface} p-4 text-xs ${theme.tint.text}`}>
          {summary}
        </pre>
      )}
    </section>
  )
}
