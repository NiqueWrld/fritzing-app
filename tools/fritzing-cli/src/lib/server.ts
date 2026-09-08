import { readdir, readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import { basename, dirname, extname, join } from 'node:path';
import {
  findParts,
  findSketches,
  getPartsRoots,
  getProjectLiveFolder,
  listPartsInSketch,
  listRunningFritzingInstances,
  readSketchModel,
  readSketchSummary,
  resolveWorkspacePath,
  runProcess,
  snapshotProject,
  writeSketchModel
} from './cli.js';

const moduleIdCache = new Map<string, string>();

async function findFzpByModuleId(moduleId: string): Promise<string | undefined> {
  const cached = moduleIdCache.get(moduleId);
  if (cached) return cached;
  for (const root of getPartsRoots()) {
    const entries = await readdir(root, { recursive: true, withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isFile() || extname(entry.name).toLowerCase() !== '.fzp') continue;
      const fzpPath = join(entry.parentPath, entry.name);
      const content = await readFile(fzpPath, 'utf8').catch(() => '');
      const foundId = content.match(/<module\b[^>]*\bmoduleId="([^"]+)"/i)?.[1];
      if (foundId && !moduleIdCache.has(foundId)) {
        moduleIdCache.set(foundId, fzpPath);
      }
      if (foundId === moduleId) return fzpPath;
    }
  }
  return undefined;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

type PinPosition = { x: number; y: number };

// Fritzing scene units are 90dpi.
const SVG_DPI = 90;

// Mirrors TextUtils::convertToInches: px is 90dpi, or 72dpi for Illustrator-generated SVGs.
function svgSizeToScene(svg: string): { width: number; height: number } | undefined {
  const isIllustrator = /Adobe Illustrator/i.test(svg.slice(0, 500));
  const parse = (name: string): number | undefined => {
    const raw = svg.match(new RegExp(`<svg[^>]*\\b${name}="([\\d.]+)([a-z%]*)"`, 'i'));
    if (!raw) return undefined;
    const value = Number(raw[1]);
    const unit = raw[2].toLowerCase();
    const divisor = unit === 'cm' ? 2.54
      : unit === 'mm' ? 25.4
      : unit === 'in' ? 1
      : unit === 'pt' ? 72
      : isIllustrator ? 72 : 90;
    return (value / divisor) * SVG_DPI;
  };
  const width = parse('width');
  const height = parse('height');
  return width !== undefined && height !== undefined ? { width, height } : undefined;
}

async function readPartImageSvg(fzpPath: string): Promise<string | undefined> {
  const fzp = await readFile(fzpPath, 'utf8').catch(() => undefined);
  if (!fzp) return undefined;
  const image = fzp.match(/<breadboardView\b[^>]*>[\s\S]*?<layers[^>]*\bimage="([^"]+)"/i)?.[1];
  if (!image) return undefined;
  const family = basename(dirname(fzpPath));
  // Imported parts (AppData local_parts) keep images in subfolders next to the fzp.
  const candidates = [join(dirname(fzpPath), image)];
  for (const root of getPartsRoots()) {
    candidates.push(join(root, 'svg', family, image), join(root, 'svg', 'core', image));
  }
  for (const candidate of candidates) {
    const svg = await readFile(candidate, 'utf8').catch(() => undefined);
    if (svg) return svg;
  }
  return undefined;
}

// Column-major 2D matrix [a b c d e f]: x' = a*x + c*y + e, y' = b*x + d*y + f.
type Mat = [number, number, number, number, number, number];
const identityMat: Mat = [1, 0, 0, 1, 0, 0];

function multiplyMat(outer: Mat, inner: Mat): Mat {
  return [
    outer[0] * inner[0] + outer[2] * inner[1],
    outer[1] * inner[0] + outer[3] * inner[1],
    outer[0] * inner[2] + outer[2] * inner[3],
    outer[1] * inner[2] + outer[3] * inner[3],
    outer[0] * inner[4] + outer[2] * inner[5] + outer[4],
    outer[1] * inner[4] + outer[3] * inner[5] + outer[5]
  ];
}

function parseTransform(value: string | undefined): Mat {
  if (!value) return identityMat;
  let matrix = identityMat;
  for (const match of value.matchAll(/(matrix|translate|scale|rotate)\s*\(([^)]*)\)/gi)) {
    const args = match[2].split(/[\s,]+/).filter(Boolean).map(Number);
    const kind = match[1].toLowerCase();
    let next: Mat = identityMat;
    if (kind === 'matrix' && args.length === 6) next = [args[0], args[1], args[2], args[3], args[4], args[5]];
    else if (kind === 'translate') next = [1, 0, 0, 1, args[0] ?? 0, args[1] ?? 0];
    else if (kind === 'scale') next = [args[0] ?? 1, 0, 0, args[1] ?? args[0] ?? 1, 0, 0];
    else if (kind === 'rotate') {
      const radians = ((args[0] ?? 0) * Math.PI) / 180;
      const cos = Math.cos(radians);
      const sin = Math.sin(radians);
      next = [cos, sin, -sin, cos, 0, 0];
      if (args.length === 3) {
        next = multiplyMat(multiplyMat([1, 0, 0, 1, args[1], args[2]], next), [1, 0, 0, 1, -args[1], -args[2]]);
      }
    }
    matrix = multiplyMat(matrix, next);
  }
  return matrix;
}

function attrOf(tag: string, name: string): string | undefined {
  return tag.match(new RegExp(`\\b${name}="([^"]*)"`, 'i'))?.[1];
}

function shapeCenter(tag: string): { x: number; y: number } | undefined {
  const cx = attrOf(tag, 'cx');
  const cy = attrOf(tag, 'cy');
  if (cx !== undefined && cy !== undefined) return { x: Number(cx), y: Number(cy) };
  const x = attrOf(tag, 'x');
  const y = attrOf(tag, 'y');
  if (x !== undefined && y !== undefined) {
    return { x: Number(x) + Number(attrOf(tag, 'width') ?? 0) / 2, y: Number(y) + Number(attrOf(tag, 'height') ?? 0) / 2 };
  }
  return undefined;
}

// Resolve an element's center in root SVG user units, honoring ancestor and own transforms.
function svgElementCenter(svg: string, svgId: string): { x: number; y: number } | undefined {
  const stack: Mat[] = [];
  const idPattern = new RegExp(`\\bid="${svgId}"`, 'i');
  let insideTarget: Mat | undefined;
  let targetDepth = 0;
  for (const match of svg.matchAll(/<\/?[a-zA-Z][^>]*>/g)) {
    const tag = match[0];
    const isClose = tag.startsWith('</');
    const isSelfClosed = tag.endsWith('/>');
    if (isClose) {
      if (insideTarget !== undefined) {
        targetDepth -= 1;
        if (targetDepth <= 0) insideTarget = undefined;
      } else {
        stack.pop();
      }
      continue;
    }
    const composed = multiplyMat(
      insideTarget ?? stack.at(-1) ?? identityMat,
      parseTransform(attrOf(tag, 'transform'))
    );
    const isTarget = idPattern.test(tag);
    if (isTarget || insideTarget !== undefined) {
      const center = shapeCenter(tag);
      if (center) {
        const [a, b, c, d, e, f] = composed;
        return { x: a * center.x + c * center.y + e, y: b * center.x + d * center.y + f };
      }
      if (!isSelfClosed) {
        if (isTarget && insideTarget === undefined) {
          insideTarget = composed;
          targetDepth = 1;
        } else {
          insideTarget = composed;
          targetDepth += 1;
        }
      }
      continue;
    }
    if (!isSelfClosed) stack.push(composed);
  }
  return undefined;
}

// Locate a connector pin's center within the part's breadboard SVG, in scene units.
async function findPinPosition(fzpPath: string, connectorId: string): Promise<PinPosition | undefined> {
  const fzp = await readFile(fzpPath, 'utf8').catch(() => undefined);
  if (!fzp) return undefined;
  const connectorBlock = fzp.match(new RegExp(`<connector[^>]*id="${connectorId}"[\\s\\S]*?</connector>`, 'i'))?.[0];
  const svgId = connectorBlock?.match(/<breadboardView>[\s\S]*?<p\b[^>]*\bsvgId="([^"]+)"/i)?.[1]
    ?? connectorBlock?.match(/<p\b[^>]*layer="breadboard"[^>]*\bsvgId="([^"]+)"/i)?.[1];
  if (!svgId) return undefined;
  const svg = await readPartImageSvg(fzpPath);
  if (!svg) return undefined;
  const center = svgElementCenter(svg, svgId);
  if (!center || Number.isNaN(center.x) || Number.isNaN(center.y)) return undefined;
  // Map user units to scene units via the viewBox against the Fritzing-converted size.
  const viewBox = svg.match(/viewBox="([^"]+)"/i)?.[1]?.split(/\s+/).map(Number);
  const sceneSize = svgSizeToScene(svg);
  if (viewBox && sceneSize && viewBox[2] > 0) {
    const scale = sceneSize.width / viewBox[2];
    return { x: (center.x - viewBox[0]) * scale, y: (center.y - viewBox[1]) * scale };
  }
  return center;
}

type WireEndTarget = { kind: 'part' | 'breadboardPin' | 'wire'; modelIndex: string; connectorId: string };

// Connect layer names per view for each kind of target (matches Fritzing-saved files).
const targetLayers: Record<WireEndTarget['kind'], { bb: string; pcb: string; sch: string }> = {
  part: { bb: 'breadboardbreadboard', pcb: 'copper1', sch: 'schematic' },
  breadboardPin: { bb: 'breadboardbreadboard', pcb: 'breadboardbreadboard', sch: 'breadboardbreadboard' },
  wire: { bb: 'breadboardWire', pcb: 'copper1trace', sch: 'schematicTrace' }
};

function newWireModelIndex(): string {
  return String(Math.floor(Math.random() * 900000) + 100000);
}

function buildWireSegment(options: {
  title: string;
  color: string;
  modelIndex: string;
  start: PinPosition;
  end: PinPosition;
  startTarget: WireEndTarget;
  endTarget: WireEndTarget;
}): string {
  const { title, color, modelIndex, start, end, startTarget, endTarget } = options;
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  // Fritzing saves the same logical wire in all three views; a single-view wire
  // triggers "Routing error: connector mismatch between views" (debugconnectors.cpp).
  const connectorsBlock = (wireLayer: string, view: 'bb' | 'pcb' | 'sch') => `
                    <connectors>
                        <connector connectorId="connector0" layer="${wireLayer}">
                            <geometry x="0" y="0"/>
                            <connects>
                                <connect connectorId="${startTarget.connectorId}" modelIndex="${startTarget.modelIndex}" layer="${targetLayers[startTarget.kind][view]}"/>
                            </connects>
                        </connector>
                        <connector connectorId="connector1" layer="${wireLayer}">
                            <geometry x="0" y="0"/>
                            <connects>
                                <connect connectorId="${endTarget.connectorId}" modelIndex="${endTarget.modelIndex}" layer="${targetLayers[endTarget.kind][view]}"/>
                            </connects>
                        </connector>
                    </connectors>`;
  return `
        <instance moduleIdRef="WireModuleID" modelIndex="${modelIndex}" path=":/resources/parts/core/wire.fzp">
            <title>${title}</title>
            <views>
                <breadboardView layer="breadboardWire">
                    <geometry z="3.5" x="${start.x}" y="${start.y}" x1="0" y1="0" x2="${dx}" y2="${dy}" wireFlags="64"/>
                    <wireExtras mils="22.2222" color="${color}" opacity="1" banded="0"/>${connectorsBlock('breadboardWire', 'bb')}
                </breadboardView>
                <pcbView layer="copper1trace">
                    <geometry z="9.5" x="${start.x}" y="${start.y}" x1="0" y1="0" x2="${dx}" y2="${dy}" wireFlags="64"/>
                    <wireExtras mils="11.1111" color="#f28a00" opacity="1" banded="0"/>${connectorsBlock('copper1trace', 'pcb')}
                </pcbView>
                <schematicView layer="schematicTrace">
                    <geometry z="5.5" x="${start.x}" y="${start.y}" x1="0" y1="0" x2="${dx}" y2="${dy}" wireFlags="64"/>
                    <wireExtras mils="33.3333" color="#404040" opacity="1" banded="0"/>${connectorsBlock('schematicTrace', 'sch')}
                </schematicView>
            </views>
        </instance>`;
}

// Manhattan routing: vertical run from the pin to the rail row, a bendpoint, then a
// horizontal run along the rail. Bendpoints are chained wire segments, as Fritzing saves them.
function routeWire(options: {
  baseTitle: string;
  color: string;
  start: PinPosition;
  end: PinPosition;
  startTarget: WireEndTarget;
  endTarget: WireEndTarget;
}): string[] {
  const { baseTitle, color, start, end, startTarget, endTarget } = options;
  const straight = Math.abs(start.x - end.x) < 2 || Math.abs(start.y - end.y) < 2;
  if (straight) {
    return [buildWireSegment({
      title: baseTitle,
      color,
      modelIndex: newWireModelIndex(),
      start,
      end,
      startTarget,
      endTarget
    })];
  }
  const firstIndex = newWireModelIndex();
  const secondIndex = newWireModelIndex();
  const bend: PinPosition = { x: start.x, y: end.y };
  return [
    buildWireSegment({
      title: `${baseTitle}_a`,
      color,
      modelIndex: firstIndex,
      start,
      end: bend,
      startTarget,
      endTarget: { kind: 'wire', modelIndex: secondIndex, connectorId: 'connector0' }
    }),
    buildWireSegment({
      title: `${baseTitle}_b`,
      color,
      modelIndex: secondIndex,
      start: bend,
      end,
      startTarget: { kind: 'wire', modelIndex: firstIndex, connectorId: 'connector1' },
      endTarget
    })
  ];
}

// Instance <transform> uses Qt row-vector convention: x' = m11*x + m21*y + m31.
function parseInstanceTransform(viewXml: string): Mat {
  const attrs = viewXml.match(/<transform\b([^>]*)\/?>/i)?.[1];
  if (!attrs) return identityMat;
  const num = (name: string, fallback: number) => {
    const value = attrs.match(new RegExp(`\\b${name}="([^"]+)"`, 'i'))?.[1];
    return value === undefined ? fallback : Number(value);
  };
  return [num('m11', 1), num('m12', 0), num('m21', 0), num('m22', 1), num('m31', 0), num('m32', 0)];
}

function applyMat(matrix: Mat, point: PinPosition): PinPosition {
  const [a, b, c, d, e, f] = matrix;
  return { x: a * point.x + c * point.y + e, y: b * point.x + d * point.y + f };
}

function requireParam(url: URL, name: string): string {
  const value = url.searchParams.get(name);
  if (!value) {
    throw new HttpError(400, `Missing required query parameter: ${name}`);
  }
  return value;
}

class HttpError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const method = req.method ?? 'GET';
  const route = `${method} ${url.pathname}`;

  switch (route) {
    case 'GET /api/sketches': {
      const folder = url.searchParams.get('folder') ?? 'sketches';
      const limit = Number(url.searchParams.get('limit') ?? '50');
      const sketches = await findSketches(resolveWorkspacePath(folder), limit);
      sendJson(res, 200, { sketches });
      return;
    }
    case 'GET /api/sketch/summary': {
      const sketchPath = resolveWorkspacePath(requireParam(url, 'path'));
      sendJson(res, 200, { summary: await readSketchSummary(sketchPath) });
      return;
    }
    case 'GET /api/sketch/model': {
      const sketchPath = resolveWorkspacePath(requireParam(url, 'path'));
      sendJson(res, 200, { xml: await readSketchModel(sketchPath) });
      return;
    }
    case 'GET /api/sketch/parts': {
      const sketchPath = resolveWorkspacePath(requireParam(url, 'path'));
      sendJson(res, 200, { parts: await listPartsInSketch(sketchPath) });
      return;
    }
    case 'GET /api/sketch/diagram': {
      // Mirrors SketchWidget::loadFromModelParts: each instance is placed at its
      // breadboardView <geometry x y z>; wires run from (x+x1,y+y1) to (x+x2,y+y2).
      const sketchPath = resolveWorkspacePath(requireParam(url, 'path'));
      const xml = await readSketchModel(sketchPath);
      const parts: Array<{ moduleIdRef: string; title: string; x: number; y: number; z: number; width?: number; height?: number; transform?: Mat }> = [];
      const wires: Array<{ x1: number; y1: number; x2: number; y2: number; color: string; width: number }> = [];
      for (const match of xml.matchAll(/<instance\b([^>]*)>([\s\S]*?)<\/instance>/gi)) {
        const attrs = match[1] ?? '';
        const body = match[2] ?? '';
        const moduleIdRef = attrs.match(/\bmoduleIdRef="([^"]+)"/i)?.[1] ?? '';
        const title = (body.match(/<title>([\s\S]*?)<\/title>/i)?.[1] ?? '').trim();
        const view = body.match(/<breadboardView[^>]*>([\s\S]*?)<\/breadboardView>/i)?.[1];
        if (!view) continue;
        const geometryAttrs = view.match(/<geometry\b([^>]*?)\/?>/i)?.[1] ?? '';
        const num = (name: string) => Number(geometryAttrs.match(new RegExp(`\\b${name}="([^"]+)"`, 'i'))?.[1] ?? '0');
        const x = num('x');
        const y = num('y');
        const isWire = /\bwireFlags="/i.test(geometryAttrs) || moduleIdRef.toLowerCase().includes('wiremoduleid');
        if (isWire) {
          const color = view.match(/<wireExtras[^>]*\bcolor="([^"]+)"/i)?.[1] ?? '#404040';
          const width = Number(view.match(/<wireExtras[^>]*\bwidth="([^"]+)"/i)?.[1] ?? '3');
          wires.push({ x1: x + num('x1'), y1: y + num('y1'), x2: x + num('x2'), y2: y + num('y2'), color, width });
        } else {
          const transform = parseInstanceTransform(view);
          parts.push({ moduleIdRef, title, x, y, z: num('z'), transform: transform === identityMat ? undefined : transform });
        }
      }
      parts.sort((a, b) => a.z - b.z);
      // Attach Fritzing-accurate scene sizes so the client renders parts at true scale.
      await Promise.all(parts.map(async part => {
        const fzpPath = await findFzpByModuleId(part.moduleIdRef);
        if (!fzpPath) return;
        const svg = await readPartImageSvg(fzpPath);
        if (!svg) return;
        const size = svgSizeToScene(svg);
        if (size) {
          part.width = size.width;
          part.height = size.height;
        }
      }));
      sendJson(res, 200, { parts, wires });
      return;
    }
    case 'GET /api/sketch/svg': {
      const sketchPath = resolveWorkspacePath(requireParam(url, 'path'));
      const svgPath = join(getProjectLiveFolder(sketchPath), 'current.svg');
      try {
        const svg = await readFile(svgPath, 'utf8');
        res.writeHead(200, { 'Content-Type': 'image/svg+xml' });
        res.end(svg);
      } catch {
        throw new HttpError(404, 'No SVG snapshot exists yet. Run a snapshot first.');
      }
      return;
    }
    case 'POST /api/sketch/snapshot': {
      const sketchPath = resolveWorkspacePath(requireParam(url, 'path'));
      sendJson(res, 200, { svgPath: await snapshotProject(sketchPath) });
      return;
    }
    case 'GET /api/parts': {
      const query = requireParam(url, 'query');
      const limit = Number(url.searchParams.get('limit') ?? '25');
      sendJson(res, 200, { parts: await findParts(query, limit) });
      return;
    }
    case 'GET /api/part/image': {
      const fzpPathParam = url.searchParams.get('path');
      const moduleId = url.searchParams.get('moduleId');
      let fzpPath: string | undefined = fzpPathParam ?? undefined;
      if (!fzpPath && moduleId) {
        fzpPath = await findFzpByModuleId(moduleId);
      }
      if (!fzpPath) {
        throw new HttpError(404, 'Part not found. Pass path or moduleId.');
      }
      const fzp = await readFile(fzpPath, 'utf8').catch(() => {
        throw new HttpError(404, `Part definition not found: ${fzpPath}`);
      });
      const image = fzp.match(/<breadboardView\b[^>]*>[\s\S]*?<layers[^>]*\bimage="([^"]+)"/i)?.[1];
      if (!image) {
        throw new HttpError(404, 'Part has no breadboard image.');
      }
      // Images live at <partsRoot>/svg/<family>/<image>; family mirrors the fzp folder (core, contrib, obsolete).
      const family = basename(dirname(fzpPath));
      const contentTypes: Record<string, string> = { '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg' };
      const contentType = contentTypes[extname(image).toLowerCase()];
      if (!contentType) {
        throw new HttpError(415, `Unsupported part image type: ${image}`);
      }
      const candidates = [
        join(dirname(fzpPath), image),
        ...getPartsRoots().flatMap(root => [
          join(root, 'svg', family, image),
          join(root, 'svg', 'core', image)
        ])
      ];
      for (const imagePath of candidates) {
        const content = await readFile(imagePath).catch(() => undefined);
        if (content) {
          res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'max-age=3600' });
          res.end(content);
          return;
        }
      }
      throw new HttpError(404, `Part image not found for ${basename(fzpPath)}: ${image}`);
    }
    case 'GET /api/instances': {
      sendJson(res, 200, { instances: await listRunningFritzingInstances() });
      return;
    }
    case 'POST /api/sketch/autowire': {
      const sketchPath = resolveWorkspacePath(requireParam(url, 'path'));
      // Start from a clean slate: remove every existing wire, then wire everything fresh.
      const xml = (await readSketchModel(sketchPath))
        .replace(/\s*<instance\b[^>]*moduleIdRef="WireModuleID"[^>]*>[\s\S]*?<\/instance>/gi, '');

      type InstanceInfo = { moduleIdRef: string; modelIndex: string; title: string; x: number; y: number; transform: Mat };
      const instances: InstanceInfo[] = [];
      for (const match of xml.matchAll(/<instance\b([^>]*)>([\s\S]*?)<\/instance>/gi)) {
        const attrs = match[1] ?? '';
        const body = match[2] ?? '';
        const moduleIdRef = attrs.match(/\bmoduleIdRef="([^"]+)"/i)?.[1] ?? '';
        const modelIndex = attrs.match(/\bmodelIndex="([^"]+)"/i)?.[1] ?? '';
        const title = (body.match(/<title>([\s\S]*?)<\/title>/i)?.[1] ?? '').trim();
        const view = body.match(/<breadboardView[^>]*>([\s\S]*?)<\/breadboardView>/i)?.[1] ?? '';
        const geometry = view.match(/<geometry\b([^>]*)\/?>/i)?.[1] ?? '';
        const x = Number(geometry.match(/\bx="([^"]+)"/i)?.[1] ?? '0');
        const y = Number(geometry.match(/\by="([^"]+)"/i)?.[1] ?? '0');
        instances.push({ moduleIdRef, modelIndex, title, x, y, transform: parseInstanceTransform(view) });
      }

      const skipModules = /^(WireModuleID|NoteModuleID|RulerModuleID|LogoImageModuleID|TwoLayerRectanglePCBModuleID)$/i;
      const breadboard = instances.find(instance => /breadboard/i.test(instance.moduleIdRef));
      if (!breadboard) throw new HttpError(404, 'No breadboard found in this sketch.');
      const breadboardFzp = await findFzpByModuleId(breadboard.moduleIdRef);
      if (!breadboardFzp) throw new HttpError(404, 'The breadboard part definition was not found.');

      const groundName = /^(gnd|ground|-|g|0v|vss)$/i;
      const wired: Array<{ from: string; to: string }> = [];
      const wireBlocks: string[] = [];
      // Use the rail pins that actually exist, in order, starting from the first one.
      const breadboardDefinition = await readFile(breadboardFzp, 'utf8').catch(() => '');
      const railColumns = [...new Set(
        [...breadboardDefinition.matchAll(/id="pin(\d+)W"/g)].map(match => Number(match[1]))
      )].sort((a, b) => a - b);
      if (railColumns.length === 0) throw new HttpError(500, 'The breadboard has no power rail connectors.');
      let railSlot = 0;

      // Wire the supply (microcontroller) first so it lands on the first rail connectors.
      const parts = [...instances].sort((a, b) =>
        Number(/arduino|uno|mega|nano|esp|micro:bit|raspberry/i.test(b.moduleIdRef)) -
        Number(/arduino|uno|mega|nano|esp|micro:bit|raspberry/i.test(a.moduleIdRef)));

      // Free MCU pins for the parts' signal lines: analog A*, digital D2+ (D0/D1 are serial).
      const mcu = parts.find(part => /arduino|uno|mega|nano|esp|micro:bit/i.test(part.moduleIdRef));
      const mcuFzp = mcu ? await findFzpByModuleId(mcu.moduleIdRef) : undefined;
      const mcuDefinition = mcuFzp ? await readFile(mcuFzp, 'utf8').catch(() => '') : '';
      const mcuConnectors = [...mcuDefinition.matchAll(/<connector[^>]*id="([^"]+)"[^>]*name="([^"]+)"/gi)]
        .map(match => ({ id: match[1], name: match[2] }));
      const seenPinNames = new Set<string>();
      const analogQueue = mcuConnectors.filter(connector => {
        const name = connector.name.toUpperCase();
        if (!/^A\d+/.test(name) || seenPinNames.has(name)) return false;
        seenPinNames.add(name);
        return true;
      });
      const digitalQueue = mcuConnectors.filter(connector => {
        const match = connector.name.toUpperCase().match(/^D(\d+)/);
        if (!match || Number(match[1]) < 2 || seenPinNames.has(connector.name.toUpperCase())) return false;
        seenPinNames.add(connector.name.toUpperCase());
        return true;
      });
      const signalColors = ['#ffe500', '#33cc00', '#3366ff', '#ff9900', '#9900cc', '#00cccc'];
      let signalCount = 0;

      for (const part of parts) {
        if (part === breadboard) continue;
        if (skipModules.test(part.moduleIdRef) || /breadboard/i.test(part.moduleIdRef)) continue;
        const fzpPath = await findFzpByModuleId(part.moduleIdRef);
        if (!fzpPath) continue;
        const definition = await readFile(fzpPath, 'utf8').catch(() => '');
        const connectors = [...definition.matchAll(/<connector[^>]*id="([^"]+)"[^>]*name="([^"]+)"/gi)]
          .map(match => ({ id: match[1], name: match[2] }));
        // Prefer 5V over generic supply names over VIN; last match wins within a tier (power headers are declared last).
        const powerTiers = [/^(5v|\+5v)$/i, /^(vcc|vdd|vs|v|v\+|\+|pwr|power|3v3|3\.3v)$/i, /^vin$/i];
        const powerId = powerTiers
          .map(tier => connectors.filter(connector => tier.test(connector.name)).at(-1)?.id)
          .find(id => id !== undefined);
        const groundId = connectors.filter(connector => groundName.test(connector.name)).at(-1)?.id;
        if (!powerId && !groundId && part !== mcu && mcuConnectors.length === 0) continue;

        const railColumn = railColumns[Math.min(railSlot, railColumns.length - 1)];
        const railPlus = `pin${railColumn}W`;
        const railMinus = `pin${railColumn}X`;
        const [powerPin, groundPin, railPlusPin, railMinusPin] = await Promise.all([
          powerId ? findPinPosition(fzpPath, powerId) : undefined,
          groundId ? findPinPosition(fzpPath, groundId) : undefined,
          findPinPosition(breadboardFzp, railPlus),
          findPinPosition(breadboardFzp, railMinus)
        ]);
        const label = part.title || part.moduleIdRef;
        const scenePoint = (owner: InstanceInfo, pin: PinPosition) => {
          const mapped = applyMat(owner.transform, pin);
          return { x: owner.x + mapped.x, y: owner.y + mapped.y };
        };

        if (powerId && powerPin && railPlusPin) {
          wireBlocks.push(...routeWire({
            baseTitle: `AutoWire5V_${part.modelIndex}`,
            color: '#cc1414',
            start: scenePoint(part, powerPin),
            end: scenePoint(breadboard, railPlusPin),
            startTarget: { kind: 'part', modelIndex: part.modelIndex, connectorId: powerId },
            endTarget: { kind: 'breadboardPin', modelIndex: breadboard.modelIndex, connectorId: railPlus }
          }));
          wired.push({ from: `${label} ${powerId} (power)`, to: `Breadboard ${railPlus} (+ rail)` });
        }
        if (groundId && groundPin && railMinusPin) {
          wireBlocks.push(...routeWire({
            baseTitle: `AutoWireGND_${part.modelIndex}`,
            color: '#404040',
            start: scenePoint(part, groundPin),
            end: scenePoint(breadboard, railMinusPin),
            startTarget: { kind: 'part', modelIndex: part.modelIndex, connectorId: groundId },
            endTarget: { kind: 'breadboardPin', modelIndex: breadboard.modelIndex, connectorId: railMinus }
          }));
          wired.push({ from: `${label} ${groundId} (ground)`, to: `Breadboard ${railMinus} (- rail)` });
        }
        if ((powerId && powerPin) || (groundId && groundPin)) {
          railSlot += 1;
        }

        // Remaining pins are signal lines: wire each to a free MCU pin (analog A*, else digital D2+).
        if (part !== mcu && mcu && mcuFzp) {
          const ncName = /^(nc|n\/c|not connected)$/i;
          const signalConnectors = connectors.filter(connector =>
            connector.id !== powerId && connector.id !== groundId &&
            !groundName.test(connector.name) && !ncName.test(connector.name) &&
            !/^(5v|\+5v|vcc|vdd|vin|3v3|3\.3v|\+|v)$/i.test(connector.name));
          for (const signal of signalConnectors) {
            const isAnalog = /^(a\d|ao|aout|analog)/i.test(signal.name);
            const mcuPin = (isAnalog ? analogQueue : digitalQueue).shift() ?? digitalQueue.shift() ?? analogQueue.shift();
            if (!mcuPin) break;
            const [signalPin, mcuPinPosition] = await Promise.all([
              findPinPosition(fzpPath, signal.id),
              findPinPosition(mcuFzp, mcuPin.id)
            ]);
            if (!signalPin || !mcuPinPosition) continue;
            wireBlocks.push(...routeWire({
              baseTitle: `AutoWireSig_${part.modelIndex}_${signal.id}`,
              color: signalColors[signalCount++ % signalColors.length],
              start: scenePoint(part, signalPin),
              end: scenePoint(mcu, mcuPinPosition),
              startTarget: { kind: 'part', modelIndex: part.modelIndex, connectorId: signal.id },
              endTarget: { kind: 'part', modelIndex: mcu.modelIndex, connectorId: mcuPin.id }
            }));
            wired.push({ from: `${label} ${signal.name} (${signal.id})`, to: `${mcu.title || 'MCU'} ${mcuPin.name}` });
          }
        }
      }

      // Join the bottom rail pair (W=+, X=-) to the top pair (Y=+, Z=-): red on the
      // last column, black on the second-to-last so the jumpers do not overlap.
      const plusColumn = railColumns.at(-1);
      const minusColumn = railColumns.at(-2) ?? plusColumn;
      if (plusColumn !== undefined && minusColumn !== undefined) {
        const jumpers: Array<{ fromPin: string; toPin: string; color: string; label: string }> = [
          { fromPin: `pin${plusColumn}W`, toPin: `pin${plusColumn}Y`, color: '#cc1414', label: '+ rails' },
          { fromPin: `pin${minusColumn}X`, toPin: `pin${minusColumn}Z`, color: '#404040', label: '- rails' }
        ];
        for (const jumper of jumpers) {
          const [fromPin, toPin] = await Promise.all([
            findPinPosition(breadboardFzp, jumper.fromPin),
            findPinPosition(breadboardFzp, jumper.toPin)
          ]);
          if (!fromPin || !toPin) continue;
          const fromScene = applyMat(breadboard.transform, fromPin);
          const toScene = applyMat(breadboard.transform, toPin);
          wireBlocks.push(...routeWire({
            baseTitle: `AutoWireRail_${jumper.fromPin}`,
            color: jumper.color,
            start: { x: breadboard.x + fromScene.x, y: breadboard.y + fromScene.y },
            end: { x: breadboard.x + toScene.x, y: breadboard.y + toScene.y },
            startTarget: { kind: 'breadboardPin', modelIndex: breadboard.modelIndex, connectorId: jumper.fromPin },
            endTarget: { kind: 'breadboardPin', modelIndex: breadboard.modelIndex, connectorId: jumper.toPin }
          }));
          wired.push({ from: `Breadboard ${jumper.fromPin}`, to: `Breadboard ${jumper.toPin} (${jumper.label})` });
        }
      }

      if (wireBlocks.length === 0) {
        throw new HttpError(404, 'No unwired parts with power/ground connectors were found.');
      }

      const updated = xml.replace(/<\/instances>/i, `${wireBlocks.join('')}\n    </instances>`);
      if (updated === xml) throw new HttpError(500, 'Could not insert wires into the sketch.');
      await writeSketchModel(sketchPath, updated, true);
      sendJson(res, 200, { wired });
      return;
    }
    case 'GET /api/browse': {
      if (process.platform !== 'win32') {
        throw new HttpError(501, 'Native file browsing is currently supported on Windows only.');
      }
      const initialDir = resolveWorkspacePath('sketches');
      const script = [
        'Add-Type -AssemblyName System.Windows.Forms',
        '$dialog = New-Object System.Windows.Forms.OpenFileDialog',
        "$dialog.Filter = 'Fritzing sketches (*.fz;*.fzz)|*.fz;*.fzz|All files (*.*)|*.*'",
        `$dialog.InitialDirectory = '${initialDir.replace(/'/g, "''")}'`,
        'if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $dialog.FileName }'
      ].join('; ');
      const result = await runProcess('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-Command', script], process.cwd());
      if (result.code !== 0) {
        throw new HttpError(500, `File dialog failed: ${result.stderr.trim() || result.stdout.trim()}`);
      }
      const picked = result.stdout.trim();
      sendJson(res, 200, { path: picked.length > 0 ? picked : null });
      return;
    }
    default:
      throw new HttpError(404, `Unknown route: ${route}`);
  }
}

export function startHttpServer(port: number): Promise<void> {
  const server = createServer((req, res) => {
    handleRequest(req, res).catch((error: unknown) => {
      const status = error instanceof HttpError ? error.status : 500;
      const message = error instanceof Error ? error.message : String(error);
      if (!res.headersSent) {
        sendJson(res, status, { error: message });
      } else {
        res.end();
      }
    });
  });

  return new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolvePromise());
  });
}
