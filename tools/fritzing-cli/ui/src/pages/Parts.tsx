import { CloudArrowUpIcon, DownloadSimpleIcon, MagnifyingGlassIcon, PuzzlePieceIcon, TrashIcon, WarningIcon } from '@phosphor-icons/react'
import { useCallback, useEffect, useState, type ChangeEvent, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { useSketch } from '../context/SketchContext'
import { useTheme } from '../context/ThemeContext'
import { useAuth } from '../context/AuthContext'
import { fetchJson, partImageUrl, type Part } from '../lib/api'
import {
  cloudPartImageUrl,
  cloudPartsAvailable,
  cloudPartsDefault,
  deleteUserPart,
  downloadUserPart,
  listUserParts,
  searchCloudParts,
  uploadUserPart,
} from '../lib/cloudStorage'

type UserPart = { name: string; size: number; uploaded: string }

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
  const [source, setSource] = useState<'local' | 'cloud'>(cloudPartsDefault ? 'cloud' : 'local')
  const [searchedSource, setSearchedSource] = useState(source)
  const { canUseStorage, getIdToken } = useAuth()
  const [userParts, setUserParts] = useState<UserPart[]>([])
  const [userPartsError, setUserPartsError] = useState<string>()
  const [uploading, setUploading] = useState(false)

  const refreshUserParts = useCallback(async () => {
    if (!canUseStorage || !cloudPartsAvailable) return setUserParts([])
    try {
      setUserParts(await listUserParts(await getIdToken()))
      setUserPartsError(undefined)
    } catch (e) {
      setUserPartsError((e as Error).message)
    }
  }, [canUseStorage, getIdToken])

  useEffect(() => {
    void refreshUserParts()
  }, [refreshUserParts])

  const runUserPartAction = async (action: () => Promise<unknown>) => {
    try {
      await action()
      await refreshUserParts()
    } catch (e) {
      setUserPartsError((e as Error).message)
    }
  }

  const onUpload = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = [...(event.target.files ?? [])]
    event.target.value = ''
    if (!files.length) return
    setUploading(true)
    const token = await getIdToken()
    await runUserPartAction(() => Promise.all(files.map(file => uploadUserPart(token, file))))
    setUploading(false)
  }

  const onDownload = (name: string) =>
    runUserPartAction(async () => {
      const blob = await downloadUserPart(await getIdToken(), name)
      const link = document.createElement('a')
      link.href = URL.createObjectURL(blob)
      link.download = name.split('/').pop() ?? name
      link.click()
      URL.revokeObjectURL(link.href)
    })

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
    const request =
      source === 'cloud'
        ? searchCloudParts(query, 25)
        : fetchJson<{ parts: Part[] }>(`/api/parts?query=${encodeURIComponent(query)}&limit=25`).then(data => data.parts)
    request
      .then(found => {
        setParts(found)
        setSearchedSource(source)
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
              <PartThumb src={partImageUrl(part.moduleIdRef)} />
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
        {cloudPartsAvailable && (
          <select
            value={source}
            onChange={event => setSource(event.target.value as 'local' | 'cloud')}
            className={`rounded-lg border ${theme.secondary.input} px-2 py-2 text-sm outline-none`}
            title="Where to search"
          >
            <option value="local">Local</option>
            <option value="cloud">Cloud</option>
          </select>
        )}
        <input
          value={query}
          onChange={event => setQuery(event.target.value)}
          placeholder={source === 'cloud' ? 'Search the cloud parts library, e.g. 555' : 'Search installed parts, e.g. 555'}
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
            <PartThumb src={searchedSource === 'cloud' ? cloudPartImageUrl({ path: part.path }) : `/api/part/image?path=${encodeURIComponent(part.path)}`} />
            <div className="min-w-0">
              <p className="font-medium">{part.title}</p>
              <p className={`mt-1 font-mono text-xs ${theme.tint.muted}`}>{part.moduleId}</p>
              <p className={`mt-1 truncate text-xs ${theme.tint.faint}`}>{part.path}</p>
            </div>
          </li>
        ))}
      </ul>

      {cloudPartsAvailable && (
        <>
          <h2 className="mb-3 mt-8 text-lg font-medium">My cloud parts</h2>
          {!canUseStorage ? (
            <p className={`text-sm ${theme.tint.faint}`}>
              <Link to="/login" className={theme.primary.link}>Sign in</Link> to keep your own parts (.fzpz, .fzp, .svg) in the cloud.
            </p>
          ) : (
            <>
              {userPartsError && (
                <div className={`mb-4 flex items-center gap-2 rounded-lg border px-4 py-3 text-sm ${theme.tint.warning}`}>
                  <WarningIcon size={18} weight="fill" />
                  {userPartsError}
                </div>
              )}
              <label className={`inline-flex cursor-pointer items-center gap-2 rounded-lg ${theme.primary.button} px-4 py-2 text-sm font-medium ${uploading ? 'opacity-50' : ''}`}>
                <CloudArrowUpIcon size={18} />
                {uploading ? 'Uploading…' : 'Upload parts'}
                <input type="file" multiple accept=".fzpz,.fzp,.svg" className="hidden" disabled={uploading} onChange={onUpload} />
              </label>
              <ul className="mt-4 space-y-2">
                {userParts.map(part => (
                  <li key={part.name} className={`flex items-center gap-4 rounded-xl border ${theme.secondary.borderSoft} ${theme.secondary.surface} p-4`}>
                    <PuzzlePieceIcon size={28} weight="duotone" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium">{part.name}</p>
                      <p className={`mt-1 text-xs ${theme.tint.faint}`}>
                        {(part.size / 1024).toFixed(1)} KB · {new Date(part.uploaded).toLocaleString()}
                      </p>
                    </div>
                    <button type="button" title="Download" onClick={() => onDownload(part.name)} className={theme.primary.link}>
                      <DownloadSimpleIcon size={20} />
                    </button>
                    <button
                      type="button"
                      title="Delete"
                      onClick={async () => {
                        if (!confirm(`Delete ${part.name} from the cloud?`)) return
                        await runUserPartAction(async () => deleteUserPart(await getIdToken(), part.name))
                      }}
                      className={theme.tint.faint}
                    >
                      <TrashIcon size={20} />
                    </button>
                  </li>
                ))}
                {userParts.length === 0 && !userPartsError && <li className={`text-sm ${theme.tint.faint}`}>No cloud parts yet.</li>}
              </ul>
            </>
          )}
        </>
      )}
    </section>
  )
}
