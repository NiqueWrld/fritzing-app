import { CameraIcon, CornersInIcon, FrameCornersIcon, LightningIcon, MagnifyingGlassMinusIcon, MagnifyingGlassPlusIcon, WarningIcon } from '@phosphor-icons/react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useSketch } from '../context/SketchContext'
import { useTheme } from '../context/ThemeContext'
import { fetchJson } from '../lib/api'

async function fetchSvg(sketchPath: string): Promise<string> {
  const response = await fetch(`/api/sketch/svg?path=${encodeURIComponent(sketchPath)}&t=${Date.now()}`)
  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: `Request failed: ${response.status}` }))
    throw new Error(body.error ?? `Request failed: ${response.status}`)
  }
  return response.text()
}

type DiagramPart = { moduleIdRef: string; title: string; x: number; y: number; z: number; width?: number; height?: number }
type DiagramWire = { x1: number; y1: number; x2: number; y2: number; color: string; width: number }
type Diagram = { parts: DiagramPart[]; wires: DiagramWire[] }

// Fallback for parts without server-computed sizes: scene 90dpi vs browser 96dpi px.
const sceneScale = 90 / 96

export default function Breadboard() {
  const { currentSketch } = useSketch()
  const { theme } = useTheme()
  const [mode, setMode] = useState<'live' | 'snapshot'>('live')
  const [diagram, setDiagram] = useState<Diagram>()
  const [svg, setSvg] = useState<string>()
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [zoom, setZoom] = useState(1)
  const canvasRef = useRef<HTMLDivElement>(null)

  // Internal widgets (notes, rulers, logos) have no part SVG in the parts library.
  const internalModules = useMemo(() => new Set(['NoteModuleID', 'RulerModuleID', 'LogoImageModuleID']), [])
  const liveBounds = useMemo(() => {
    if (!diagram) return undefined
    const drawableParts = diagram.parts.filter(part => !internalModules.has(part.moduleIdRef))
    const xs = [...drawableParts.map(p => p.x), ...diagram.wires.flatMap(w => [w.x1, w.x2])]
    const ys = [...drawableParts.map(p => p.y), ...diagram.wires.flatMap(w => [w.y1, w.y2])]
    // Scene coordinates can be negative; shift the origin like adjustSceneRect does.
    const margin = 40
    const offsetX = Math.min(0, ...xs) - margin
    const offsetY = Math.min(0, ...ys) - margin
    return {
      drawableParts,
      offsetX,
      offsetY,
      width: Math.max(0, ...xs) - offsetX + 400,
      height: Math.max(0, ...ys) - offsetY + 400,
    }
  }, [diagram, internalModules])

  const zoomToFit = () => {
    const canvas = canvasRef.current
    const content = canvas?.querySelector<HTMLElement>('[data-canvas-content]')
    if (!canvas || !content) return
    // calculateVisibleItemsBoundingRect: union of the actual item bounds (parts and wire lines).
    let elements: Element[] = [...content.querySelectorAll('img'), ...content.querySelectorAll('line')]
    if (elements.length === 0) elements = [...content.querySelectorAll('svg')]
    const origin = content.getBoundingClientRect()
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (const element of elements) {
      const rect = element.getBoundingClientRect()
      if (rect.width === 0 && rect.height === 0) continue
      minX = Math.min(minX, rect.left)
      minY = Math.min(minY, rect.top)
      maxX = Math.max(maxX, rect.right)
      maxY = Math.max(maxY, rect.bottom)
    }
    if (!Number.isFinite(minX)) return
    // Back to scene units at zoom 1.
    const itemsRect = {
      x: (minX - origin.left) / zoom,
      y: (minY - origin.top) / zoom,
      width: (maxX - minX) / zoom,
      height: (maxY - minY) / zoom,
    }
    // SketchWidget::fitInWindow adds a 3% border around the items.
    const borderFactor = 0.03
    itemsRect.x -= itemsRect.width * borderFactor
    itemsRect.y -= itemsRect.height * borderFactor
    itemsRect.width *= 1 + 2 * borderFactor
    itemsRect.height *= 1 + 2 * borderFactor
    const fit = Math.min(canvas.clientWidth / itemsRect.width, canvas.clientHeight / itemsRect.height)
    const newZoom = Math.min(4, Math.max(0.25, fit))
    setZoom(newZoom)
    // fitInView(KeepAspectRatio) centers the rect in the viewport.
    requestAnimationFrame(() => {
      canvas.scrollLeft = itemsRect.x * newZoom - (canvas.clientWidth - itemsRect.width * newZoom) / 2
      canvas.scrollTop = itemsRect.y * newZoom - (canvas.clientHeight - itemsRect.height * newZoom) / 2
    })
  }

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

  const loadDiagram = useCallback(() => {
    if (!currentSketch) return
    setBusy(true)
    fetchJson<Diagram>(`/api/sketch/diagram?path=${encodeURIComponent(currentSketch)}`)
      .then(data => {
        setDiagram(data)
        setError(undefined)
      })
      .catch((requestError: Error) => {
        setDiagram(undefined)
        setError(requestError.message)
      })
      .finally(() => setBusy(false))
  }, [currentSketch])

  useEffect(() => {
    if (mode === 'live') loadDiagram()
    else loadSvg()
  }, [mode, loadDiagram, loadSvg])

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

  const autoWire = () => {
    if (!currentSketch) return
    setBusy(true)
    fetchJson<{ wired: Array<{ from: string; to: string }> }>(
      `/api/sketch/autowire?path=${encodeURIComponent(currentSketch)}`,
      { method: 'POST' }
    )
      .then(() => {
        setError(undefined)
        loadDiagram()
      })
      .catch((requestError: Error) => {
        setError(requestError.message)
        setBusy(false)
      })
  }

  if (!currentSketch) {
    return (
      <section>
        <h2 className="mb-3 text-lg font-medium">Breadboard view</h2>
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
        <h2 className="text-lg font-medium">Breadboard view</h2>
        <div className="flex items-center gap-2">
          <div className={`flex overflow-hidden rounded-lg border ${theme.secondary.border}`}>
            {(['live', 'snapshot'] as const).map(candidate => (
              <button
                key={candidate}
                type="button"
                onClick={() => setMode(candidate)}
                className={`px-3 py-2 text-sm transition ${mode === candidate ? theme.primary.active : theme.tint.muted}`}
              >
                {candidate === 'live' ? 'Live' : 'Snapshot'}
              </button>
            ))}
          </div>
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
            onClick={zoomToFit}
            className={`rounded-lg border ${theme.secondary.border} p-2 transition ${theme.primary.hoverBorder}`}
            aria-label="Zoom to fit"
            title="Zoom to fit"
          >
            <CornersInIcon size={18} />
          </button>
          {mode === 'live' && (
            <button
              type="button"
              onClick={autoWire}
              disabled={busy}
              className={`flex items-center gap-2 rounded-lg ${theme.primary.button} px-4 py-2 text-sm font-medium transition disabled:opacity-50`}
              title="Wire the Uno's 5V and GND to the breadboard power rails"
            >
              <LightningIcon size={18} />
              Auto wire
            </button>
          )}
          {mode === 'snapshot' && (
            <button
              type="button"
              onClick={takeSnapshot}
              disabled={busy}
              className={`flex items-center gap-2 rounded-lg ${theme.primary.button} px-4 py-2 text-sm font-medium transition disabled:opacity-50`}
            >
              <CameraIcon size={18} />
              Snapshot
            </button>
          )}
        </div>
      </div>

      {error && (
        <div className={`mb-4 flex items-center gap-2 rounded-lg border px-4 py-3 text-sm ${theme.tint.warning}`}>
          <WarningIcon size={18} weight="fill" />
          <span>{error} Try Snapshot to generate a fresh export.</span>
        </div>
      )}

      {busy && <p className={`mb-4 text-sm ${theme.tint.muted}`}>Working…</p>}

      <div
        ref={canvasRef}
        className={`min-h-0 flex-1 overflow-auto rounded-xl border ${theme.secondary.borderSoft} ${theme.secondary.canvasBg}`}
        style={{
          // Fritzing breadboard grid: 0.1in pitch, gridColor from theme
          backgroundImage: `linear-gradient(to right, ${theme.secondary.gridColor} 1px, transparent 1px), linear-gradient(to bottom, ${theme.secondary.gridColor} 1px, transparent 1px)`,
          backgroundSize: `${9.6 * zoom}px ${9.6 * zoom}px`,
          backgroundAttachment: 'local',
        }}
      >
        {mode === 'live' && diagram && liveBounds && (() => {
          const { drawableParts, width, height, offsetX, offsetY } = liveBounds
          return (
            <div data-canvas-content className="relative origin-top-left" style={{ transform: `scale(${zoom})`, width, height }}>
              {drawableParts.map((part, index) => (
                <img
                  key={`${part.moduleIdRef}-${index}`}
                  src={`/api/part/image?moduleId=${encodeURIComponent(part.moduleIdRef)}`}
                  alt={part.title}
                  title={part.title}
                  className="absolute origin-top-left"
                  style={part.width && part.height
                    ? { left: part.x - offsetX, top: part.y - offsetY, width: part.width, height: part.height }
                    : { left: part.x - offsetX, top: part.y - offsetY, transform: `scale(${sceneScale})` }}
                  onError={event => (event.currentTarget.style.display = 'none')}
                />
              ))}
              <svg className="pointer-events-none absolute left-0 top-0" width={width} height={height}>
                {diagram.wires.map((wire, index) => (
                  <line
                    key={index}
                    x1={wire.x1 - offsetX}
                    y1={wire.y1 - offsetY}
                    x2={wire.x2 - offsetX}
                    y2={wire.y2 - offsetY}
                    stroke={wire.color}
                    strokeWidth={wire.width}
                    strokeLinecap="round"
                  />
                ))}
              </svg>
            </div>
          )
        })()}
        {mode === 'live' && !diagram && !busy && (
          <p className={`p-4 text-sm ${theme.tint.faint}`}>No diagram data for this sketch.</p>
        )}
        {mode === 'snapshot' && (svg ? (
          <div
            data-canvas-content
            className="origin-top-left p-4 [&_svg]:h-auto"
            style={{ transform: `scale(${zoom})`, width: `${100 / zoom}%` }}
            dangerouslySetInnerHTML={{ __html: svg }}
          />
        ) : (
          !busy && <p className={`p-4 text-sm ${theme.tint.faint}`}>No snapshot yet. Use Snapshot to export this sketch.</p>
        ))}
      </div>
    </section>
  )
}
