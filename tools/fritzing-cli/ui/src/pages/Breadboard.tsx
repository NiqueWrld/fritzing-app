import { CameraIcon, FrameCornersIcon, MagnifyingGlassMinusIcon, MagnifyingGlassPlusIcon, WarningIcon } from '@phosphor-icons/react'
import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useSketch } from '../context/SketchContext'
import { fetchJson } from '../lib/api'

async function fetchSvg(sketchPath: string): Promise<string> {
  const response = await fetch(`/api/sketch/svg?path=${encodeURIComponent(sketchPath)}&t=${Date.now()}`)
  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: `Request failed: ${response.status}` }))
    throw new Error(body.error ?? `Request failed: ${response.status}`)
  }
  return response.text()
}

export default function Breadboard() {
  const { currentSketch } = useSketch()
  const [svg, setSvg] = useState<string>()
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [zoom, setZoom] = useState(1)

  const loadSvg = useCallback(() => {
    if (!currentSketch) return
    setBusy(true)
    fetchSvg(currentSketch)
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

  useEffect(loadSvg, [loadSvg])

  const takeSnapshot = () => {
    if (!currentSketch) return
    setBusy(true)
    fetchJson<{ svgPath: string }>(`/api/sketch/snapshot?path=${encodeURIComponent(currentSketch)}`, { method: 'POST' })
      .then(loadSvg)
      .catch((requestError: Error) => {
        setError(requestError.message)
        setBusy(false)
      })
  }

  if (!currentSketch) {
    return (
      <section>
        <h2 className="mb-3 text-lg font-medium">Breadboard view</h2>
        <p className="text-sm text-slate-500">
          No sketch selected. Pick one on the{' '}
          <Link to="/" className="text-sky-400 underline">
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
        <h2 className="text-lg font-medium">Breadboard view</h2>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setZoom(current => Math.max(0.25, current - 0.25))}
            className="rounded-lg border border-slate-700 p-2 transition hover:border-sky-500"
            aria-label="Zoom out"
          >
            <MagnifyingGlassMinusIcon size={18} />
          </button>
          <span className="w-14 text-center text-sm text-slate-400">{Math.round(zoom * 100)}%</span>
          <button
            type="button"
            onClick={() => setZoom(current => Math.min(4, current + 0.25))}
            className="rounded-lg border border-slate-700 p-2 transition hover:border-sky-500"
            aria-label="Zoom in"
          >
            <MagnifyingGlassPlusIcon size={18} />
          </button>
          <button
            type="button"
            onClick={() => setZoom(1)}
            className="rounded-lg border border-slate-700 p-2 transition hover:border-sky-500"
            aria-label="Reset zoom"
          >
            <FrameCornersIcon size={18} />
          </button>
          <button
            type="button"
            onClick={takeSnapshot}
            disabled={busy}
            className="flex items-center gap-2 rounded-lg bg-sky-600 px-4 py-2 text-sm font-medium transition hover:bg-sky-500 disabled:opacity-50"
          >
            <CameraIcon size={18} />
            Snapshot
          </button>
        </div>
      </div>

      {error && (
        <div className="mb-4 flex items-center gap-2 rounded-lg border border-amber-600 bg-amber-950 px-4 py-3 text-sm text-amber-200">
          <WarningIcon size={18} weight="fill" />
          <span>{error} Try Snapshot to generate a fresh export.</span>
        </div>
      )}

      {busy && <p className="mb-4 text-sm text-slate-400">Working…</p>}

      <div
        className="min-h-0 flex-1 overflow-auto rounded-xl border border-slate-800 bg-white"
        style={{
          // Fritzing breadboard grid: 0.1in pitch, gridColor rgba(0,50,100,20/255)
          backgroundImage:
            'linear-gradient(to right, rgba(0,50,100,0.08) 1px, transparent 1px), linear-gradient(to bottom, rgba(0,50,100,0.08) 1px, transparent 1px)',
          backgroundSize: `${9.6 * zoom}px ${9.6 * zoom}px`,
          backgroundAttachment: 'local',
        }}
      >
        {svg ? (
          <div
            className="origin-top-left p-4 [&_svg]:h-auto"
            style={{ transform: `scale(${zoom})`, width: `${100 / zoom}%` }}
            dangerouslySetInnerHTML={{ __html: svg }}
          />
        ) : (
          !busy && <p className="p-4 text-sm text-slate-500">No snapshot yet. Use Snapshot to export this sketch.</p>
        )}
      </div>
    </section>
  )
}
