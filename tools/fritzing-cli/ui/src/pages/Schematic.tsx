import { CameraIcon, CopyIcon, CornersInIcon, FrameCornersIcon, MagnifyingGlassMinusIcon, MagnifyingGlassPlusIcon, WarningIcon } from '@phosphor-icons/react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useSketch } from '../context/SketchContext'
import { useTheme } from '../context/ThemeContext'
import { fetchJson } from '../lib/api'

async function fetchSchematicSvg(sketchPath: string): Promise<{ text: string; stale: boolean; missing: boolean }> {
  const response = await fetch(`/api/sketch/svg?path=${encodeURIComponent(sketchPath)}&view=schematic&t=${Date.now()}`)
  if (response.status === 404) return { text: '', stale: false, missing: true }
  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: `Request failed: ${response.status}` }))
    throw new Error(body.error ?? `Request failed: ${response.status}`)
  }
  return { text: await response.text(), stale: response.headers.get('X-Svg-Stale') === '1', missing: false }
}

type DiagramPart = {
  moduleIdRef: string
  title: string
  x: number
  y: number
  z: number
  width?: number
  height?: number
  transform?: [number, number, number, number, number, number]
}
type DiagramWire = { x1: number; y1: number; x2: number; y2: number; color: string; width: number }
type Diagram = { parts: DiagramPart[]; wires: DiagramWire[] }

// Fritzing scene units are 90dpi; browsers render SVG physical units at 96dpi.
const sceneScale = 90 / 96

async function svgToPngBlob(svgText: string, width: number, height: number): Promise<Blob> {
  const image = new Image()
  const svgUrl = URL.createObjectURL(new Blob([svgText], { type: 'image/svg+xml' }))
  try {
    await new Promise((resolve, reject) => {
      image.onload = resolve
      image.onerror = () => reject(new Error('Could not render the image.'))
      image.src = svgUrl
    })
    const scale = 2
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(width * scale))
    canvas.height = Math.max(1, Math.round(height * scale))
    const context = canvas.getContext('2d')
    if (!context) throw new Error('Canvas is not available.')
    context.fillStyle = '#ffffff'
    context.fillRect(0, 0, canvas.width, canvas.height)
    context.drawImage(image, 0, 0, canvas.width, canvas.height)
    return await new Promise((resolve, reject) => {
      canvas.toBlob(blob => (blob ? resolve(blob) : reject(new Error('Could not encode the image.'))), 'image/png')
    })
  } finally {
    URL.revokeObjectURL(svgUrl)
  }
}

export default function Schematic() {
  const { currentSketch } = useSketch()
  const { theme } = useTheme()
  const [mode, setMode] = useState<'exact' | 'live'>('exact')
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
    const xs = [
      ...drawableParts.flatMap(p => [p.x, p.x + (p.width ?? 200)]),
      ...diagram.wires.flatMap(w => [w.x1, w.x2]),
    ]
    const ys = [
      ...drawableParts.flatMap(p => [p.y, p.y + (p.height ?? 200)]),
      ...diagram.wires.flatMap(w => [w.y1, w.y2]),
    ]
    if (xs.length === 0) return undefined
    const margin = 30
    const offsetX = Math.min(...xs) - margin
    const offsetY = Math.min(...ys) - margin
    return {
      drawableParts,
      offsetX,
      offsetY,
      width: Math.max(...xs) - offsetX + margin,
      height: Math.max(...ys) - offsetY + margin,
    }
  }, [diagram, internalModules])

  // Exact mode shows the real C++ renderer's output, re-exporting when the sketch changed.
  const loadSvg = useCallback(async () => {
    if (!currentSketch) return
    setBusy(true)
    try {
      let result = await fetchSchematicSvg(currentSketch)
      if (result.missing || result.stale) {
        await fetchJson<{ svgPath: string }>(`/api/sketch/snapshot?path=${encodeURIComponent(currentSketch)}`, { method: 'POST' })
        result = await fetchSchematicSvg(currentSketch)
      }
      setSvg(result.missing ? undefined : result.text)
      setError(undefined)
    } catch (loadError) {
      setSvg(undefined)
      setError(loadError instanceof Error ? loadError.message : String(loadError))
    } finally {
      setBusy(false)
    }
  }, [currentSketch])

  const loadDiagram = useCallback(() => {
    if (!currentSketch) return
    setBusy(true)
    fetchJson<Diagram>(`/api/sketch/diagram?path=${encodeURIComponent(currentSketch)}&view=schematic`)
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
    else void loadSvg()
  }, [mode, loadDiagram, loadSvg])

  const takeSnapshot = () => {
    if (!currentSketch) return
    setBusy(true)
    fetchJson<{ svgPath: string }>(`/api/sketch/snapshot?path=${encodeURIComponent(currentSketch)}`, { method: 'POST' })
      .then(() => loadSvg())
      .catch((requestError: Error) => {
        setError(requestError.message)
        setBusy(false)
      })
  }

  const zoomToFit = () => {
    const canvas = canvasRef.current
    const content = canvas?.querySelector<HTMLElement>('[data-canvas-content]')
    if (!canvas || !content) return
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
    requestAnimationFrame(() => {
      canvas.scrollLeft = itemsRect.x * newZoom - (canvas.clientWidth - itemsRect.width * newZoom) / 2
      canvas.scrollTop = itemsRect.y * newZoom - (canvas.clientHeight - itemsRect.height * newZoom) / 2
    })
  }

  const copyImage = async () => {
    try {
      let blob: Blob
      if (mode === 'live' && diagram && liveBounds) {
        const { drawableParts, width, height, offsetX, offsetY } = liveBounds
        const scale = 2
        const canvas = document.createElement('canvas')
        canvas.width = Math.max(1, Math.round(width * scale))
        canvas.height = Math.max(1, Math.round(height * scale))
        const context = canvas.getContext('2d')
        if (!context) throw new Error('Canvas is not available.')
        context.fillStyle = '#ffffff'
        context.fillRect(0, 0, canvas.width, canvas.height)
        context.scale(scale, scale)
        for (const part of drawableParts) {
          const image = new Image()
          await new Promise(resolve => {
            image.onload = resolve
            image.onerror = resolve
            image.src = `/api/part/image?moduleId=${encodeURIComponent(part.moduleIdRef)}&view=schematic`
          })
          if (!image.naturalWidth) continue
          context.save()
          context.translate(part.x - offsetX, part.y - offsetY)
          if (part.transform) context.transform(...part.transform)
          context.drawImage(
            image,
            0,
            0,
            part.width ?? image.naturalWidth * sceneScale,
            part.height ?? image.naturalHeight * sceneScale
          )
          context.restore()
        }
        for (const wire of diagram.wires) {
          context.strokeStyle = wire.color
          context.lineWidth = wire.width
          context.lineCap = 'round'
          context.beginPath()
          context.moveTo(wire.x1 - offsetX, wire.y1 - offsetY)
          context.lineTo(wire.x2 - offsetX, wire.y2 - offsetY)
          context.stroke()
        }
        blob = await new Promise((resolve, reject) => {
          canvas.toBlob(result => (result ? resolve(result) : reject(new Error('Could not encode the image.'))), 'image/png')
        })
      } else if (mode === 'exact' && svg) {
        const element = canvasRef.current?.querySelector('svg')
        blob = await svgToPngBlob(svg, element?.width.baseVal.value ?? 800, element?.height.baseVal.value ?? 600)
      } else {
        return
      }
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
      setError(undefined)
    } catch (copyError) {
      setError(copyError instanceof Error ? copyError.message : String(copyError))
    }
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
          <div className={`flex overflow-hidden rounded-lg border ${theme.secondary.border}`}>
            {(['exact', 'live'] as const).map(candidate => (
              <button
                key={candidate}
                type="button"
                onClick={() => setMode(candidate)}
                className={`px-3 py-2 text-sm transition ${mode === candidate ? theme.primary.active : theme.tint.muted}`}
              >
                {candidate === 'exact' ? 'Exact (C++)' : 'Live'}
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
          {mode === 'exact' && (
            <button
              type="button"
              onClick={takeSnapshot}
              disabled={busy}
              className={`flex items-center gap-2 rounded-lg ${theme.primary.button} px-4 py-2 text-sm font-medium transition disabled:opacity-50`}
              title="Re-render with the Fritzing app"
            >
              <CameraIcon size={18} />
              Re-render
            </button>
          )}
          <button
            type="button"
            onClick={copyImage}
            className={`flex items-center gap-2 rounded-lg border ${theme.secondary.border} px-3 py-2 text-sm transition ${theme.primary.hoverBorder}`}
            title="Copy the current view to the clipboard as an image"
          >
            <CopyIcon size={18} />
            Copy image
          </button>
        </div>
      </div>

      {error && (
        <div className={`mb-4 flex items-center gap-2 rounded-lg border px-4 py-3 text-sm ${theme.tint.warning}`}>
          <WarningIcon size={18} weight="fill" />
          <span>{error}</span>
        </div>
      )}

      {busy && <p className={`mb-4 text-sm ${theme.tint.muted}`}>Rendering with Fritzing…</p>}

      <div
        ref={canvasRef}
        className={`min-h-0 flex-1 overflow-auto rounded-xl border ${theme.secondary.borderSoft} ${theme.secondary.canvasBg}`}
        style={{
          // Fritzing schematic grid: 0.1in pitch, same gridColor as the app.
          backgroundImage: `linear-gradient(to right, ${theme.secondary.gridColor} 1px, transparent 1px), linear-gradient(to bottom, ${theme.secondary.gridColor} 1px, transparent 1px)`,
          backgroundSize: `${9.6 * zoom}px ${9.6 * zoom}px`,
          backgroundAttachment: 'local',
        }}
      >
        {mode === 'live' && diagram && liveBounds && (() => {
          const { drawableParts, width, height, offsetX, offsetY } = liveBounds
          return (
            <div data-canvas-content className="relative origin-top-left" style={{ transform: `scale(${zoom})`, width, height }}>
              {drawableParts.map((part, index) => {
                const rotation = part.transform ? `matrix(${part.transform.join(',')})` : ''
                const style = part.width && part.height
                  ? { left: part.x - offsetX, top: part.y - offsetY, width: part.width, height: part.height, transform: rotation || undefined }
                  : { left: part.x - offsetX, top: part.y - offsetY, transform: `${rotation} scale(${sceneScale})`.trim() }
                return (
                  <img
                    key={`${part.moduleIdRef}-${index}`}
                    src={`/api/part/image?moduleId=${encodeURIComponent(part.moduleIdRef)}&view=schematic`}
                    alt={part.title}
                    title={part.title}
                    className="absolute origin-top-left"
                    style={style}
                    onError={event => (event.currentTarget.style.display = 'none')}
                  />
                )
              })}
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
          <p className={`p-4 text-sm ${theme.tint.faint}`}>No schematic data for this sketch.</p>
        )}
        {mode === 'exact' && (svg ? (
          <div
            data-canvas-content
            className="origin-top-left p-4 [&_svg]:h-auto"
            style={{ transform: `scale(${zoom})`, width: `${100 / zoom}%` }}
            dangerouslySetInnerHTML={{ __html: svg }}
          />
        ) : (
          !busy && <p className={`p-4 text-sm ${theme.tint.faint}`}>No schematic export yet. Use Re-render to generate one.</p>
        ))}
      </div>
    </section>
  )
}
