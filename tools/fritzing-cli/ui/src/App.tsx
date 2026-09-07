import { ArrowsClockwiseIcon, CircuitryIcon, FileCodeIcon, MagnifyingGlassIcon, WarningIcon } from '@phosphor-icons/react'
import { useCallback, useEffect, useState, type FormEvent } from 'react'

type Part = { moduleId: string; title: string; path: string }

async function fetchJson<T>(input: string, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init)
  const body = await response.json()
  if (!response.ok) {
    throw new Error(body.error ?? `Request failed: ${response.status}`)
  }
  return body as T
}

export default function App() {
  const [sketches, setSketches] = useState<string[]>([])
  const [selectedSketch, setSelectedSketch] = useState<string>()
  const [summary, setSummary] = useState<string>()
  const [query, setQuery] = useState('')
  const [parts, setParts] = useState<Part[]>([])
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
    setSelectedSketch(sketch)
    setSummary(undefined)
    fetchJson<{ summary: string }>(`/api/sketch/summary?path=${encodeURIComponent(sketch)}`)
      .then(data => setSummary(data.summary))
      .catch((requestError: Error) => setError(requestError.message))
  }

  const searchParts = (event: FormEvent) => {
    event.preventDefault()
    if (!query.trim()) return
    setBusy(true)
    fetchJson<{ parts: Part[] }>(`/api/parts?query=${encodeURIComponent(query)}&limit=25`)
      .then(data => {
        setParts(data.parts)
        setError(undefined)
      })
      .catch((requestError: Error) => setError(requestError.message))
      .finally(() => setBusy(false))
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <header className="flex items-center justify-between border-b border-slate-800 px-8 py-6">
        <div>
          <h1 className="flex items-center gap-3 text-2xl font-semibold">
            <CircuitryIcon size={32} weight="duotone" className="text-sky-400" />
            Fritzing Workspace
          </h1>
          <p className="mt-1 text-sm text-slate-400">Served by fritzing-cli on port 3000</p>
        </div>
        <button
          type="button"
          onClick={loadSketches}
          className="flex items-center gap-2 rounded-lg border border-slate-700 px-3 py-2 text-sm transition hover:border-sky-500"
        >
          <ArrowsClockwiseIcon size={18} />
          Refresh
        </button>
      </header>

      {error && (
        <div className="mx-8 mt-6 flex items-center gap-2 rounded-lg border border-amber-600 bg-amber-950 px-4 py-3 text-sm text-amber-200">
          <WarningIcon size={18} weight="fill" />
          {error}
        </div>
      )}

      <main className="grid gap-8 p-8 lg:grid-cols-2">
        <section>
          <h2 className="mb-3 text-lg font-medium">Sketches</h2>
          <ul className="space-y-1">
            {sketches.map(sketch => (
              <li key={sketch}>
                <button
                  type="button"
                  onClick={() => selectSketch(sketch)}
                  className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm transition hover:bg-slate-900 ${
                    sketch === selectedSketch ? 'bg-slate-900 text-sky-300' : 'text-slate-300'
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

        <section>
          <h2 className="mb-3 text-lg font-medium">Part search</h2>
          <form onSubmit={searchParts} className="flex gap-2">
            <input
              value={query}
              onChange={event => setQuery(event.target.value)}
              placeholder="Search installed parts, e.g. 555"
              className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm outline-none focus:border-sky-500"
            />
            <button
              type="submit"
              disabled={busy}
              className="flex items-center gap-2 rounded-lg bg-sky-600 px-4 py-2 text-sm font-medium transition hover:bg-sky-500 disabled:opacity-50"
            >
              <MagnifyingGlassIcon size={18} />
              Search
            </button>
          </form>
          <ul className="mt-4 space-y-2">
            {parts.map(part => (
              <li key={part.path} className="rounded-xl border border-slate-800 bg-slate-900 p-4">
                <p className="font-medium">{part.title}</p>
                <p className="mt-1 font-mono text-xs text-slate-400">{part.moduleId}</p>
                <p className="mt-1 truncate text-xs text-slate-500">{part.path}</p>
              </li>
            ))}
          </ul>
        </section>
      </main>
    </div>
  )
}
