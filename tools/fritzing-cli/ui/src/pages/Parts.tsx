import { MagnifyingGlassIcon, WarningIcon } from '@phosphor-icons/react'
import { useState, type FormEvent } from 'react'
import { useTheme } from '../context/ThemeContext'
import { fetchJson, type Part } from '../lib/api'

export default function Parts() {
  const { theme } = useTheme()
  const [query, setQuery] = useState('')
  const [parts, setParts] = useState<Part[]>([])
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)

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
          <li key={part.path} className={`rounded-xl border ${theme.secondary.borderSoft} ${theme.secondary.surface} p-4`}>
            <p className="font-medium">{part.title}</p>
            <p className={`mt-1 font-mono text-xs ${theme.tint.muted}`}>{part.moduleId}</p>
            <p className={`mt-1 truncate text-xs ${theme.tint.faint}`}>{part.path}</p>
          </li>
        ))}
      </ul>
    </section>
  )
}
