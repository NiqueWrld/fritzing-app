import { ArrowsClockwiseIcon, FileCodeIcon, FolderOpenIcon, WarningIcon } from '@phosphor-icons/react'
import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { useSketch } from '../context/SketchContext'
import { fetchJson } from '../lib/api'

export default function Sketches() {
  const [sketches, setSketches] = useState<string[]>([])
  const { currentSketch, setCurrentSketch } = useSketch()
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
          className="flex items-center gap-2 rounded-lg border border-slate-700 px-3 py-2 text-sm transition hover:border-sky-500"
        >
          <ArrowsClockwiseIcon size={18} />
          Refresh
        </button>
      </div>

      {error && (
        <div className="mb-4 flex items-center gap-2 rounded-lg border border-amber-600 bg-amber-950 px-4 py-3 text-sm text-amber-200">
          <WarningIcon size={18} weight="fill" />
          {error}
        </div>
      )}

      <form onSubmit={loadTypedPath} className="mb-4 flex gap-2">
        <input
          value={pathInput}
          onChange={event => setPathInput(event.target.value)}
          placeholder="Type or paste a sketch path (.fz / .fzz)"
          className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm outline-none focus:border-sky-500"
        />
        <button
          type="submit"
          disabled={!pathInput.trim()}
          className="rounded-lg border border-slate-700 px-3 py-2 text-sm transition hover:border-sky-500 disabled:opacity-50"
        >
          Load
        </button>
        <button
          type="button"
          onClick={browseForSketch}
          disabled={busy}
          className="flex items-center gap-2 rounded-lg border border-slate-700 px-3 py-2 text-sm transition hover:border-sky-500 disabled:opacity-50"
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
              className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm transition hover:bg-slate-900 ${
                sketch === currentSketch ? 'bg-slate-900 text-sky-300' : 'text-slate-300'
              }`}
            >
              <FileCodeIcon size={18} className="shrink-0 text-sky-400" />
              <span className="truncate">{sketch}</span>
            </button>
          </li>
        ))}
        {sketches.length === 0 && !error && <li className="text-sm text-slate-500">No sketches found.</li>}
      </ul>
      {summary && (
        <pre className="mt-4 overflow-auto rounded-xl border border-slate-800 bg-slate-900 p-4 text-xs text-slate-300">
          {summary}
        </pre>
      )}
    </section>
  )
}
