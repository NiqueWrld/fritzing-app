import { CameraIcon, FrameCornersIcon, MagnifyingGlassMinusIcon, MagnifyingGlassPlusIcon, WarningIcon } from '@phosphor-icons/react'
import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useSketch } from '../context/SketchContext'
import { useTheme } from '../context/ThemeContext'
import { fetchJson } from '../lib/api'

async function fetchSchematicSvg(sketchPath: string): Promise<string> {
  const response = await fetch(`/api/sketch/svg?path=${encodeURIComponent(sketchPath)}&view=schematic&t=${Date.now()}`)
  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: `Request failed: ${response.status}` }))
    throw new Error(body.error ?? `Request failed: ${response.status}`)
  }
  return response.text()
}

export default function Schematic() {
  const { currentSketch } = useSketch()
  const { theme } = useTheme()
  const [svg, setSvg] = useState<string>()
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [zoom, setZoom] = useState(1)

  const load = useCallback(() => {
    if (!currentSketch) return
    setBusy(true)
    fetchSchematicSvg(currentSketch)
      .then(svgText => {
        setSvg(svgText)
        setError(undefined)
      })
      .catch((requestError: Error) => {
        setSvg(undefined)
        setError(requestError.message)
      })
      .finally(() => setBusy(false))
  }, [currentSketch])

  useEffect(load, [load])

  const takeSnapshot = () => {
    if (!currentSketch) return
    setBusy(true)
    fetchJson<{ svgPath: string }>(`/api/sketch/snapshot?path=${encodeURIComponent(currentSketch)}`, { method: 'POST' })
      .then(load)
      .catch((requestError: Error) => {
        setError(requestError.message)
        setBusy(false)
      })
  }

  if (!currentSketch) {
    return (
      <section>
        <h2 className="mb-3 text-lg font-medium">Schematic view</h2>
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
    <section className="flex h-[calc(100vh-4rem)] flex-col">
      <div className="mb-4 flex items-center justify-between gap-4">
        <h2 className="text-lg font-medium">Schematic view</h2>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setZoom(current => Math.max(0.25, current - 0.25))}
            className={`rounded-lg border ${theme.secondary.border} p-2 transition ${theme.primary.hoverBorder}`}
            aria-label="Zoom out"
          >
            <MagnifyingGlassMinusIcon size={18} />
          </button>
          <span className={`w-14 text-center text-sm ${theme.tint.muted}`}>{Math.round(zoom * 100)}%</span>
          <button
            type="button"
            onClick={() => setZoom(current => Math.min(4, current + 0.25))}
            className={`rounded-lg border ${theme.secondary.border} p-2 transition ${theme.primary.hoverBorder}`}
            aria-label="Zoom in"
          >
            <MagnifyingGlassPlusIcon size={18} />
          </button>
          <button
            type="button"
            onClick={() => setZoom(1)}
            className={`rounded-lg border ${theme.secondary.border} p-2 transition ${theme.primary.hoverBorder}`}
            aria-label="Reset zoom"
          >
            <FrameCornersIcon size={18} />
          </button>
          <button
            type="button"
            onClick={takeSnapshot}
            disabled={busy}
            className={`flex items-center gap-2 rounded-lg ${theme.primary.button} px-4 py-2 text-sm font-medium transition disabled:opacity-50`}
          >
            <CameraIcon size={18} />
            Snapshot
          </button>
        </div>
      </div>

      {error && (
        <div className={`mb-4 flex items-center gap-2 rounded-lg border px-4 py-3 text-sm ${theme.tint.warning}`}>
          <WarningIcon size={18} weight="fill" />
          <span>{error}</span>
        </div>
      )}

      {busy && <p className={`mb-4 text-sm ${theme.tint.muted}`}>Working…</p>}

      <div className={`min-h-0 flex-1 overflow-auto rounded-xl border ${theme.secondary.borderSoft} ${theme.secondary.canvasBg}`}>
        {svg ? (
          <div
            className="origin-top-left p-4 [&_svg]:h-auto"
            style={{ transform: `scale(${zoom})`, width: `${100 / zoom}%` }}
            dangerouslySetInnerHTML={{ __html: svg }}
          />
        ) : (
          !busy && <p className={`p-4 text-sm ${theme.tint.faint}`}>No schematic export yet. Use Snapshot to generate one.</p>
        )}
      </div>
    </section>
  )
}
