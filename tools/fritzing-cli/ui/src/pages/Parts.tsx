import { MagnifyingGlassIcon, PuzzlePieceIcon, WarningIcon } from '@phosphor-icons/react'
import { useEffect, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { useSketch } from '../context/SketchContext'
import { useTheme } from '../context/ThemeContext'
import { fetchJson, type Part } from '../lib/api'

type SketchPart = { title: string; moduleIdRef: string; path: string; x: string; y: string }

function PartThumb({ src }: { src: string }) {
  const { theme } = useTheme()
  const [failed, setFailed] = useState(false)

  useEffect(() => setFailed(false), [src])

  if (failed) {
    return (
      <div className={`flex h-16 w-16 shrink-0 items-center justify-center rounded bg-white ${theme.tint.faint}`}>
        <PuzzlePieceIcon size={28} weight="duotone" />
      </div>
    )
  }
  return (
    <img
      src={src}
      alt=""
      loading="lazy"
      className="h-16 w-16 shrink-0 rounded bg-white object-contain p-1"
      onError={() => setFailed(true)}
    />
  )
}

export default function Parts() {
  const { theme } = useTheme()
  const { currentSketch } = useSketch()
  const [sketchParts, setSketchParts] = useState<SketchPart[]>([])
  const [sketchError, setSketchError] = useState<string>()
  const [query, setQuery] = useState('')
  const [parts, setParts] = useState<Part[]>([])
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!currentSketch) {
      setSketchParts([])
      return
    }
    fetchJson<{ parts: SketchPart[] }>(`/api/sketch/parts?path=${encodeURIComponent(currentSketch)}`)
      .then(data => {
        setSketchParts(data.parts)
        setSketchError(undefined)
      })
      .catch((requestError: Error) => setSketchError(requestError.message))
  }, [currentSketch])

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
    <section>
      <h2 className="mb-3 text-lg font-medium">Parts in sketch</h2>
      {!currentSketch && (
        <p className={`mb-6 text-sm ${theme.tint.faint}`}>
          No sketch selected. Pick one on the{' '}
          <Link to="/" className={theme.primary.link}>
            Sketches page
          </Link>
          .
        </p>
      )}
      {sketchError && (
        <div className={`mb-4 flex items-center gap-2 rounded-lg border px-4 py-3 text-sm ${theme.tint.warning}`}>
          <WarningIcon size={18} weight="fill" />
          {sketchError}
        </div>
      )}
      {currentSketch && (
        <ul className="mb-8 space-y-2">
          {sketchParts.map((part, index) => (
            <li key={`${part.moduleIdRef}-${index}`} className={`flex items-center gap-4 rounded-xl border ${theme.secondary.borderSoft} ${theme.secondary.surface} p-4`}>
              <PartThumb src={`/api/part/image?moduleId=${encodeURIComponent(part.moduleIdRef)}`} />
              <div className="min-w-0">
                <p className="font-medium">{part.title || '(untitled)'}</p>
                <p className={`mt-1 font-mono text-xs ${theme.tint.muted}`}>{part.moduleIdRef || '(none)'}</p>
                <p className={`mt-1 truncate text-xs ${theme.tint.faint}`}>position: ({part.x}, {part.y})</p>
              </div>
            </li>
          ))}
          {sketchParts.length === 0 && !sketchError && (
            <li className={`text-sm ${theme.tint.faint}`}>No parts found in this sketch.</li>
          )}
        </ul>
      )}

      <h2 className="mb-3 text-lg font-medium">Part search</h2>

      {error && (
        <div className={`mb-4 flex items-center gap-2 rounded-lg border px-4 py-3 text-sm ${theme.tint.warning}`}>
          <WarningIcon size={18} weight="fill" />
          {error}
        </div>
      )}

      <form onSubmit={searchParts} className="flex gap-2">
        <input
          value={query}
          onChange={event => setQuery(event.target.value)}
          placeholder="Search installed parts, e.g. 555"
          className={`w-full rounded-lg border ${theme.secondary.input} px-3 py-2 text-sm outline-none ${theme.primary.focusBorder}`}
        />
        <button
          type="submit"
          disabled={busy}
          className={`flex items-center gap-2 rounded-lg ${theme.primary.button} px-4 py-2 text-sm font-medium transition disabled:opacity-50`}
        >
          <MagnifyingGlassIcon size={18} />
          Search
        </button>
      </form>
      <ul className="mt-4 space-y-2">
        {parts.map(part => (
          <li key={part.path} className={`flex items-center gap-4 rounded-xl border ${theme.secondary.borderSoft} ${theme.secondary.surface} p-4`}>
            <PartThumb src={`/api/part/image?path=${encodeURIComponent(part.path)}`} />
            <div className="min-w-0">
              <p className="font-medium">{part.title}</p>
              <p className={`mt-1 font-mono text-xs ${theme.tint.muted}`}>{part.moduleId}</p>
              <p className={`mt-1 truncate text-xs ${theme.tint.faint}`}>{part.path}</p>
            </div>
          </li>
        ))}
      </ul>
    </section>
  )
}
