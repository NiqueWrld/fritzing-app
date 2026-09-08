import { spawn } from 'node:child_process';
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
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

function readRequestBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolvePromise(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

type PinPosition = { x: number; y: number };

// Autowire settings are owned by the server and persisted next to the CLI.
type AutowireSettings = {
  placeParts: boolean;
  resetRotations: boolean;
  railJumpers: boolean;
  wireSignals: boolean;
  cleanOnly: boolean;
  boardGap: number;
  partSpacing: number;
};
const defaultAutowireSettings: AutowireSettings = {
  placeParts: true,
  resetRotations: true,
  railJumpers: true,
  wireSignals: true,
  cleanOnly: false,
  boardGap: 60,
  partSpacing: 45
};
function autowireSettingsPath(): string {
  return resolveWorkspacePath('tools/fritzing-cli/autowire-settings.json');
}
async function loadAutowireSettings(): Promise<AutowireSettings> {
  const raw = await readFile(autowireSettingsPath(), 'utf8').catch(() => undefined);
  if (!raw) return { ...defaultAutowireSettings };
  try {
    return { ...defaultAutowireSettings, ...(JSON.parse(raw) as Partial<AutowireSettings>) };
  } catch {
    return { ...defaultAutowireSettings };
  }
}
function sanitizeAutowireSettings(input: unknown): AutowireSettings {
  const candidate = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>;
  const bool = (name: keyof AutowireSettings): boolean =>
    typeof candidate[name] === 'boolean' ? candidate[name] as boolean : defaultAutowireSettings[name] as boolean;
  const num = (name: 'boardGap' | 'partSpacing'): number => {
    const value = Number(candidate[name]);
    return Number.isFinite(value) && value >= 10 && value <= 300 ? value : defaultAutowireSettings[name];
  };
  return {
    placeParts: bool('placeParts'),
    resetRotations: bool('resetRotations'),
    railJumpers: bool('railJumpers'),
    wireSignals: bool('wireSignals'),
    cleanOnly: bool('cleanOnly'),
    boardGap: num('boardGap'),
    partSpacing: num('partSpacing')
  };
}
async function saveAutowireSettings(settings: AutowireSettings): Promise<void> {
  await writeFile(autowireSettingsPath(), JSON.stringify(settings, null, 2), 'utf8');
}

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

async function readPartImageSvg(fzpPath: string, viewTag = 'breadboardView'): Promise<string | undefined> {
  const fzp = await readFile(fzpPath, 'utf8').catch(() => undefined);
  if (!fzp) return undefined;
  const image = fzp.match(new RegExp(`<${viewTag}\\b[^>]*>[\\s\\S]*?<layers[^>]*\\bimage="([^"]+)"`, 'i'))?.[1];
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
const pinPositionCache = new Map<string, PinPosition | undefined>();
async function findPinPosition(fzpPath: string, connectorId: string): Promise<PinPosition | undefined> {
  const cacheKey = `${fzpPath}|${connectorId}`;
  if (pinPositionCache.has(cacheKey)) return pinPositionCache.get(cacheKey);
  const result = await findPinPositionUncached(fzpPath, connectorId);
  pinPositionCache.set(cacheKey, result);
  return result;
}

async function findPinPositionUncached(fzpPath: string, connectorId: string): Promise<PinPosition | undefined> {
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
    return chainWire([start, end], baseTitle, color, startTarget, endTarget);
  }
  return chainWire([start, { x: start.x, y: end.y }, end], baseTitle, color, startTarget, endTarget);
}

// Build a polyline as chained wire segments joined by mutual wire-to-wire connects.
function chainWire(points: PinPosition[], baseTitle: string, color: string, startTarget: WireEndTarget, endTarget: WireEndTarget): string[] {
  if (points.length < 2) return [];
  const ids = points.slice(1).map(() => newWireModelIndex());
  const blocks: string[] = [];
  for (let i = 1; i < points.length; i += 1) {
    blocks.push(buildWireSegment({
      title: points.length === 2 ? baseTitle : `${baseTitle}_${i}`,
      color,
      modelIndex: ids[i - 1],
      start: points[i - 1],
      end: points[i],
      startTarget: i === 1 ? startTarget : { kind: 'wire', modelIndex: ids[i - 2], connectorId: 'connector1' },
      endTarget: i === points.length - 1 ? endTarget : { kind: 'wire', modelIndex: ids[i], connectorId: 'connector0' }
    }));
  }
  return blocks;
}

type Rect = { x1: number; y1: number; x2: number; y2: number };

// Grid A* with turn penalties; obstacle rects are parts, occupied cells are other wires.
function findPath(start: PinPosition, end: PinPosition, obstacles: Rect[], occupied: Set<string>): PinPosition[] | undefined {
  const G = 8;
  const pad = 12 * G;
  const rawMinX = Math.min(start.x, end.x, ...obstacles.map(o => o.x1)) - pad;
  const rawMinY = Math.min(start.y, end.y, ...obstacles.map(o => o.y1)) - pad;
  const maxX = Math.max(start.x, end.x, ...obstacles.map(o => o.x2)) + pad;
  const maxY = Math.max(start.y, end.y, ...obstacles.map(o => o.y2)) + pad;
  // Anchor the grid on the start pin so it lies exactly on a node.
  const minX = start.x - Math.ceil((start.x - rawMinX) / G) * G;
  const minY = start.y - Math.ceil((start.y - rawMinY) / G) * G;
  const cols = Math.ceil((maxX - minX) / G) + 1;
  const rows = Math.ceil((maxY - minY) / G) + 1;
  if (cols < 2 || rows < 2 || cols * rows > 300000) return undefined;

  const inflate = 4;
  const blockedCache = new Map<number, boolean>();
  const isBlocked = (cx: number, cy: number): boolean => {
    const cacheKey = cy * cols + cx;
    let value = blockedCache.get(cacheKey);
    if (value === undefined) {
      const px = minX + cx * G;
      const py = minY + cy * G;
      value = obstacles.some(o => px >= o.x1 - inflate && px <= o.x2 + inflate && py >= o.y1 - inflate && py <= o.y2 + inflate);
      blockedCache.set(cacheKey, value);
    }
    return value;
  };

  const startCell = { cx: Math.round((start.x - minX) / G), cy: Math.round((start.y - minY) / G) };
  const endCell = { cx: Math.min(cols - 1, Math.max(0, Math.round((end.x - minX) / G))), cy: Math.min(rows - 1, Math.max(0, Math.round((end.y - minY) / G))) };
  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  type Node = { cx: number; cy: number; dir: number; cost: number; f: number };
  const heap: Node[] = [];
  const push = (node: Node) => {
    heap.push(node);
    let i = heap.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (heap[parent].f <= heap[i].f) break;
      [heap[parent], heap[i]] = [heap[i], heap[parent]];
      i = parent;
    }
  };
  const pop = (): Node | undefined => {
    if (heap.length === 0) return undefined;
    const top = heap[0];
    const last = heap.pop();
    if (heap.length > 0 && last) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const left = 2 * i + 1;
        const right = left + 1;
        let smallest = i;
        if (left < heap.length && heap[left].f < heap[smallest].f) smallest = left;
        if (right < heap.length && heap[right].f < heap[smallest].f) smallest = right;
        if (smallest === i) break;
        [heap[smallest], heap[i]] = [heap[i], heap[smallest]];
        i = smallest;
      }
    }
    return top;
  };

  const heuristic = (cx: number, cy: number) => Math.abs(cx - endCell.cx) + Math.abs(cy - endCell.cy);
  const best = new Map<string, number>();
  const prev = new Map<string, string>();
  const startKey = `${startCell.cx},${startCell.cy},-1`;
  best.set(startKey, 0);
  push({ cx: startCell.cx, cy: startCell.cy, dir: -1, cost: 0, f: heuristic(startCell.cx, startCell.cy) });
  let goalKey: string | undefined;
  let iterations = 0;

  while (heap.length > 0 && iterations < 400000) {
    iterations += 1;
    const node = pop();
    if (!node) break;
    const nodeKey = `${node.cx},${node.cy},${node.dir}`;
    if ((best.get(nodeKey) ?? Infinity) < node.cost) continue;
    if (node.cx === endCell.cx && node.cy === endCell.cy) {
      goalKey = nodeKey;
      break;
    }
    for (let d = 0; d < 4; d += 1) {
      const nx = node.cx + dirs[d][0];
      const ny = node.cy + dirs[d][1];
      if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
      const isEndpoint = (nx === endCell.cx && ny === endCell.cy) || (nx === startCell.cx && ny === startCell.cy);
      if (!isEndpoint && isBlocked(nx, ny)) continue;
      const turn = node.dir !== -1 && node.dir !== d ? 4 : 0;
      const busy = occupied.has(`${Math.round((minX + nx * G) / G)},${Math.round((minY + ny * G) / G)}`) ? 6 : 0;
      const cost = node.cost + 1 + turn + busy;
      const key = `${nx},${ny},${d}`;
      if ((best.get(key) ?? Infinity) <= cost) continue;
      best.set(key, cost);
      prev.set(key, nodeKey);
      push({ cx: nx, cy: ny, dir: d, cost, f: cost + heuristic(nx, ny) });
    }
  }
  if (!goalKey) return undefined;

  const cells: Array<{ cx: number; cy: number }> = [];
  for (let key: string | undefined = goalKey; key; key = prev.get(key)) {
    const [cx, cy] = key.split(',').map(Number);
    if (cells.length === 0 || cells[0].cx !== cx || cells[0].cy !== cy) {
      cells.unshift({ cx, cy });
    }
  }

  const points: PinPosition[] = cells.map(cell => ({ x: minX + cell.cx * G, y: minY + cell.cy * G }));
  // Merge collinear runs.
  const simplified: PinPosition[] = [];
  for (const point of points) {
    const n = simplified.length;
    if (n >= 2) {
      const a = simplified[n - 2];
      const b = simplified[n - 1];
      if ((a.x === b.x && b.x === point.x) || (a.y === b.y && b.y === point.y)) {
        simplified[n - 1] = point;
        continue;
      }
    }
    simplified.push(point);
  }
  // Snap endpoints to the exact pins, keeping segments orthogonal.
  simplified[0] = start;
  const last = simplified.length - 1;
  if (last >= 1) {
    if (simplified[last].x === simplified[last - 1].x) simplified[last - 1] = { ...simplified[last - 1], x: end.x };
    else simplified[last - 1] = { ...simplified[last - 1], y: end.y };
  }
  simplified[last] = end;
  if (last >= 1) {
    if (Math.abs(simplified[1].x - start.x) < Math.abs(simplified[1].y - start.y)) simplified[1] = { ...simplified[1], x: start.x };
  }
  return simplified;
}

function markOccupied(points: PinPosition[], occupied: Set<string>): void {
  const G = 8;
  for (let i = 1; i < points.length; i += 1) {
    const steps = Math.max(1, Math.round(Math.max(Math.abs(points[i].x - points[i - 1].x), Math.abs(points[i].y - points[i - 1].y)) / G));
    for (let s = 0; s <= steps; s += 1) {
      const px = points[i - 1].x + ((points[i].x - points[i - 1].x) * s) / steps;
      const py = points[i - 1].y + ((points[i].y - points[i - 1].y) * s) / steps;
      occupied.add(`${Math.round(px / G)},${Math.round(py / G)}`);
    }
  }
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

// Extract logical wire connections (part endpoints of each chained wire run).
function extractWireConnections(xml: string): Array<{ color: string; ends: Array<{ modelIndex: string; connectorId: string }> }> {
  const all = [...xml.matchAll(/<instance\b([^>]*)>([\s\S]*?)<\/instance>/gi)].map(match => ({
    moduleIdRef: (match[1] ?? '').match(/moduleIdRef="([^"]+)"/i)?.[1] ?? '',
    modelIndex: (match[1] ?? '').match(/modelIndex="([^"]+)"/i)?.[1] ?? '',
    body: match[2] ?? ''
  }));
  const byIndex = new Map(all.map(inst => [inst.modelIndex, inst]));
  const wires = all.filter(inst => inst.moduleIdRef === 'WireModuleID');
  const infos = wires.map((wire, index) => {
    const bb = wire.body.match(/<breadboardView[^>]*>([\s\S]*?)<\/breadboardView>/i)?.[1] ?? '';
    return {
      index,
      color: bb.match(/color="([^"]+)"/i)?.[1] ?? '#404040',
      connects: [...bb.matchAll(/<connect\b[^>]*connectorId="([^"]+)"[^>]*modelIndex="([^"]+)"/gi)].map(c => ({
        connectorId: c[1],
        modelIndex: c[2],
        isWire: byIndex.get(c[2])?.moduleIdRef === 'WireModuleID'
      }))
    };
  });
  const indexByModel = new Map(wires.map((wire, index) => [wire.modelIndex, index]));
  const visited = new Set<number>();
  const connections: Array<{ color: string; ends: Array<{ modelIndex: string; connectorId: string }> }> = [];
  for (const info of infos) {
    if (visited.has(info.index)) continue;
    const queue = [info.index];
    visited.add(info.index);
    const ends: Array<{ modelIndex: string; connectorId: string }> = [];
    let color = info.color;
    while (queue.length > 0) {
      const current = infos[queue.pop() as number];
      color = current.color;
      for (const connect of current.connects) {
        if (connect.isWire) {
          const neighbor = indexByModel.get(connect.modelIndex);
          if (neighbor !== undefined && !visited.has(neighbor)) {
            visited.add(neighbor);
            queue.push(neighbor);
          }
        } else {
          ends.push({ modelIndex: connect.modelIndex, connectorId: connect.connectorId });
        }
      }
    }
    if (ends.length >= 2) connections.push({ color, ends: [ends[0], ends[1]] });
  }
  return connections;
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
      // per-view <geometry x y z>; wires run from (x+x1,y+y1) to (x+x2,y+y2).
      const sketchPath = resolveWorkspacePath(requireParam(url, 'path'));
      const viewTag = url.searchParams.get('view') === 'schematic' ? 'schematicView' : 'breadboardView';
      const xml = await readSketchModel(sketchPath);
      const parts: Array<{ moduleIdRef: string; title: string; x: number; y: number; z: number; width?: number; height?: number; transform?: Mat }> = [];
      const wires: Array<{ x1: number; y1: number; x2: number; y2: number; color: string; width: number }> = [];
      for (const match of xml.matchAll(/<instance\b([^>]*)>([\s\S]*?)<\/instance>/gi)) {
        const attrs = match[1] ?? '';
        const body = match[2] ?? '';
        const moduleIdRef = attrs.match(/\bmoduleIdRef="([^"]+)"/i)?.[1] ?? '';
        const title = (body.match(/<title>([\s\S]*?)<\/title>/i)?.[1] ?? '').trim();
        // Parts never placed in this view have no geometry; fall back to breadboard placement.
        const view = body.match(new RegExp(`<${viewTag}[^>]*>([\\s\\S]*?)</${viewTag}>`, 'i'))?.[1]
          ?? body.match(/<breadboardView[^>]*>([\s\S]*?)<\/breadboardView>/i)?.[1];
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
        const svg = await readPartImageSvg(fzpPath, viewTag);
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
      const liveFolder = getProjectLiveFolder(sketchPath);
      const view = url.searchParams.get('view');
      let svgPath = join(liveFolder, 'current.svg');
      if (view) {
        // Fritzing's -svg export writes one file per view (…_schematic.svg, …_pcb.svg, …).
        const entries = await readdir(liveFolder).catch(() => []);
        const match = entries
          .filter(name => name.toLowerCase().endsWith('.svg') && name.toLowerCase().includes(view.toLowerCase()))
          .sort()
          .at(-1);
        if (!match) {
          throw new HttpError(404, `No ${view} export exists yet. Run a snapshot first.`);
        }
        svgPath = join(liveFolder, match);
      }
      try {
        const svg = await readFile(svgPath, 'utf8');
        // Tell the client when the sketch changed after the export was made.
        const [sketchStat, svgStat] = await Promise.all([
          stat(sketchPath).catch(() => undefined),
          stat(svgPath).catch(() => undefined)
        ]);
        const stale = sketchStat && svgStat && sketchStat.mtimeMs > svgStat.mtimeMs;
        res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'X-Svg-Stale': stale ? '1' : '0' });
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
      const imageViewTag = url.searchParams.get('view') === 'schematic' ? 'schematicView' : 'breadboardView';
      const image = fzp.match(new RegExp(`<${imageViewTag}\\b[^>]*>[\\s\\S]*?<layers[^>]*\\bimage="([^"]+)"`, 'i'))?.[1];
      if (!image) {
        throw new HttpError(404, `Part has no ${imageViewTag} image.`);
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
    case 'GET /api/settings/autowire': {
      sendJson(res, 200, await loadAutowireSettings());
      return;
    }
    case 'POST /api/settings/autowire': {
      let parsed: unknown;
      try {
        parsed = JSON.parse(await readRequestBody(req));
      } catch {
        throw new HttpError(400, 'Body must be valid JSON.');
      }
      const settings = sanitizeAutowireSettings(parsed);
      await saveAutowireSettings(settings);
      sendJson(res, 200, settings);
      return;
    }
    case 'GET /api/sketch/connections': {
      const sketchPath = resolveWorkspacePath(requireParam(url, 'path'));
      const xml = await readSketchModel(sketchPath);
      type Inst = { moduleIdRef: string; modelIndex: string; title: string; body: string };
      const all: Inst[] = [...xml.matchAll(/<instance\b([^>]*)>([\s\S]*?)<\/instance>/gi)].map(match => ({
        moduleIdRef: (match[1] ?? '').match(/moduleIdRef="([^"]+)"/i)?.[1] ?? '',
        modelIndex: (match[1] ?? '').match(/modelIndex="([^"]+)"/i)?.[1] ?? '',
        title: ((match[2] ?? '').match(/<title>([\s\S]*?)<\/title>/i)?.[1] ?? '').trim(),
        body: match[2] ?? ''
      }));
      const byIndex = new Map(all.map(inst => [inst.modelIndex, inst]));
      const wireInstances = all.filter(inst => inst.moduleIdRef === 'WireModuleID');
      const partInstances = all.filter(inst => inst.moduleIdRef !== 'WireModuleID');

      // Resolve connector ids to human names from the part definitions.
      const nameCache = new Map<string, Map<string, string>>();
      const connectorName = async (inst: Inst, connectorId: string): Promise<string> => {
        let names = nameCache.get(inst.moduleIdRef);
        if (!names) {
          names = new Map();
          const fzpPath = await findFzpByModuleId(inst.moduleIdRef);
          const definition = fzpPath ? await readFile(fzpPath, 'utf8').catch(() => '') : '';
          for (const match of definition.matchAll(/<connector[^>]*id="([^"]+)"[^>]*name="([^"]+)"/gi)) {
            names.set(match[1], match[2]);
          }
          nameCache.set(inst.moduleIdRef, names);
        }
        const name = names.get(connectorId);
        return name && name !== connectorId ? `${name} (${connectorId})` : connectorId;
      };

      type WireInfo = { index: number; color: string; connects: Array<{ modelIndex: string; connectorId: string; isWire: boolean }> };
      const wireInfos: WireInfo[] = wireInstances.map((wire, index) => {
        const bb = wire.body.match(/<breadboardView[^>]*>([\s\S]*?)<\/breadboardView>/i)?.[1] ?? '';
        return {
          index,
          color: bb.match(/color="([^"]+)"/i)?.[1] ?? '#404040',
          connects: [...bb.matchAll(/<connect\b[^>]*connectorId="([^"]+)"[^>]*modelIndex="([^"]+)"/gi)].map(c => ({
            connectorId: c[1],
            modelIndex: c[2],
            isWire: byIndex.get(c[2])?.moduleIdRef === 'WireModuleID'
          }))
        };
      });

      // Group chained wire segments into logical part-to-part connections.
      const indexByModel = new Map(wireInstances.map((wire, index) => [wire.modelIndex, index]));
      const visited = new Set<number>();
      const connections: Array<{ from: string; to: string; fromRef: string; toRef: string; color: string; segments: number }> = [];
      const floating: string[] = [];
      for (const info of wireInfos) {
        if (visited.has(info.index)) continue;
        const queue = [info.index];
        const component: WireInfo[] = [];
        visited.add(info.index);
        while (queue.length > 0) {
          const current = wireInfos[queue.pop() as number];
          component.push(current);
          for (const connect of current.connects) {
            if (!connect.isWire) continue;
            const neighbor = indexByModel.get(connect.modelIndex);
            if (neighbor !== undefined && !visited.has(neighbor)) {
              visited.add(neighbor);
              queue.push(neighbor);
            }
          }
        }
        const endpoints: string[] = [];
        const endpointRefs: string[] = [];
        for (const segment of component) {
          for (const connect of segment.connects) {
            if (connect.isWire) continue;
            const target = byIndex.get(connect.modelIndex);
            if (!target) continue;
            endpoints.push(`${target.title || target.moduleIdRef}: ${await connectorName(target, connect.connectorId)}`);
            endpointRefs.push(`${target.title || target.moduleIdRef}:${connect.connectorId}`);
          }
        }
        if (endpoints.length >= 2) {
          connections.push({
            from: endpoints[0],
            to: endpoints[1],
            fromRef: endpointRefs[0],
            toRef: endpointRefs[1],
            color: component[0].color,
            segments: component.length
          });
        } else {
          floating.push(`${wireInstances[component[0].index].title || 'Wire'} (${component.length} segment${component.length === 1 ? '' : 's'})`);
        }
      }

      // Full connector lists per part so consumers can build valid connection refs.
      const partConnectors = new Map<string, Array<{ id: string; name: string }>>();
      for (const part of partInstances) {
        if (partConnectors.has(part.moduleIdRef)) continue;
        const fzpPath = await findFzpByModuleId(part.moduleIdRef);
        const definition = fzpPath ? await readFile(fzpPath, 'utf8').catch(() => '') : '';
        partConnectors.set(part.moduleIdRef, [...definition.matchAll(/<connector[^>]*id="([^"]+)"[^>]*name="([^"]+)"/gi)]
          .map(match => ({ id: match[1], name: match[2] })));
      }

      sendJson(res, 200, {
        parts: partInstances.map(part => ({
          title: part.title || '(untitled)',
          moduleIdRef: part.moduleIdRef,
          connectors: partConnectors.get(part.moduleIdRef) ?? []
        })),
        connections,
        floating,
        wireSegments: wireInstances.length
      });
      return;
    }
    case 'POST /api/sketch/connections': {
      const sketchPath = resolveWorkspacePath(requireParam(url, 'path'));
      let payload: { connections?: Array<{ from?: string; to?: string; color?: string }> };
      try {
        payload = JSON.parse(await readRequestBody(req));
      } catch {
        throw new HttpError(400, 'Body must be valid JSON: { "connections": [{ "from": "Part:connectorId", "to": "Part:connectorId", "color": "#rrggbb" }] }');
      }
      const requested = payload.connections;
      if (!Array.isArray(requested) || requested.length === 0) {
        throw new HttpError(400, 'JSON must contain a non-empty "connections" array.');
      }

      // All existing wires are replaced by the pasted list.
      const xml = (await readSketchModel(sketchPath))
        .replace(/\s*<instance\b[^>]*moduleIdRef="WireModuleID"[^>]*>[\s\S]*?<\/instance>/gi, '');

      type InstanceInfo = { moduleIdRef: string; modelIndex: string; title: string; x: number; y: number; transform: Mat };
      const instances: InstanceInfo[] = [];
      for (const match of xml.matchAll(/<instance\b([^>]*)>([\s\S]*?)<\/instance>/gi)) {
        const attrs = match[1] ?? '';
        const body = match[2] ?? '';
        const view = body.match(/<breadboardView[^>]*>([\s\S]*?)<\/breadboardView>/i)?.[1] ?? '';
        const geometry = view.match(/<geometry\b([^>]*)\/?>/i)?.[1] ?? '';
        instances.push({
          moduleIdRef: attrs.match(/\bmoduleIdRef="([^"]+)"/i)?.[1] ?? '',
          modelIndex: attrs.match(/\bmodelIndex="([^"]+)"/i)?.[1] ?? '',
          title: (body.match(/<title>([\s\S]*?)<\/title>/i)?.[1] ?? '').trim(),
          x: Number(geometry.match(/\bx="([^"]+)"/i)?.[1] ?? '0'),
          y: Number(geometry.match(/\by="([^"]+)"/i)?.[1] ?? '0'),
          transform: parseInstanceTransform(view)
        });
      }
      const byLabel = new Map<string, InstanceInfo>();
      for (const inst of instances) {
        if (inst.title) byLabel.set(inst.title.toLowerCase(), inst);
        byLabel.set(inst.modelIndex, inst);
      }

      const errors: string[] = [];
      type ResolvedEnd = { inst: InstanceInfo; connectorId: string; point: PinPosition; kind: WireEndTarget['kind'] };
      const resolveEnd = async (ref: string | undefined, index: number, side: string): Promise<ResolvedEnd | undefined> => {
        if (!ref || typeof ref !== 'string' || !ref.includes(':')) {
          errors.push(`Connection ${index + 1} ${side}: expected "Part:connectorId", got ${JSON.stringify(ref)}`);
          return undefined;
        }
        const splitAt = ref.lastIndexOf(':');
        const partLabel = ref.slice(0, splitAt).trim();
        const connectorId = ref.slice(splitAt + 1).trim();
        const inst = byLabel.get(partLabel.toLowerCase());
        if (!inst) {
          errors.push(`Connection ${index + 1} ${side}: no part titled '${partLabel}'`);
          return undefined;
        }
        const fzpPath = await findFzpByModuleId(inst.moduleIdRef);
        if (!fzpPath) {
          errors.push(`Connection ${index + 1} ${side}: part definition not found for '${partLabel}'`);
          return undefined;
        }
        const pin = await findPinPosition(fzpPath, connectorId);
        if (!pin) {
          errors.push(`Connection ${index + 1} ${side}: connector '${connectorId}' not found on '${partLabel}'`);
          return undefined;
        }
        const mapped = applyMat(inst.transform, pin);
        return {
          inst,
          connectorId,
          point: { x: inst.x + mapped.x, y: inst.y + mapped.y },
          kind: /breadboard/i.test(inst.moduleIdRef) ? 'breadboardPin' : 'part'
        };
      };

      const resolved: Array<{ from: ResolvedEnd; to: ResolvedEnd; color: string }> = [];
      for (let i = 0; i < requested.length; i += 1) {
        const [from, to] = await Promise.all([
          resolveEnd(requested[i].from, i, 'from'),
          resolveEnd(requested[i].to, i, 'to')
        ]);
        if (from && to) {
          const color = typeof requested[i].color === 'string' && /^#[0-9a-f]{3,8}$/i.test(requested[i].color as string)
            ? (requested[i].color as string)
            : '#404040';
          resolved.push({ from, to, color });
        }
      }
      if (errors.length > 0) {
        throw new HttpError(400, `Connections were not applied:\n${errors.join('\n')}`);
      }

      const wireBlocks: string[] = [];
      resolved.forEach((connection, index) => {
        wireBlocks.push(...routeWire({
          baseTitle: `JsonWire_${index + 1}`,
          color: connection.color,
          start: connection.from.point,
          end: connection.to.point,
          startTarget: { kind: connection.from.kind, modelIndex: connection.from.inst.modelIndex, connectorId: connection.from.connectorId },
          endTarget: { kind: connection.to.kind, modelIndex: connection.to.inst.modelIndex, connectorId: connection.to.connectorId }
        }));
      });

      const updated = xml.replace(/<\/instances>/i, `${wireBlocks.join('')}\n    </instances>`);
      if (updated === xml) throw new HttpError(500, 'Could not insert wires into the sketch.');
      await writeSketchModel(sketchPath, updated, true);
      sendJson(res, 200, { applied: resolved.length });
      return;
    }
    case 'POST /api/sketch/open': {
      const sketchPath = resolveWorkspacePath(requireParam(url, 'path'));
      const executable = process.env.FRITZING_LAUNCH_EXECUTABLE
        ?? resolveWorkspacePath('build/debug32/Fritzing.exe');
      const executableExists = await readFile(executable).then(() => true).catch(() => false);
      if (!executableExists) {
        throw new HttpError(404, `Fritzing executable not found: ${executable}`);
      }
      // The debug build is not single-instance: activate an existing window instead of stacking copies.
      const running = await listRunningFritzingInstances().catch(() => []);
      const existing = running.find(instance => instance.executablePath.toLowerCase() === executable.toLowerCase());
      if (existing) {
        const script = `(New-Object -ComObject WScript.Shell).AppActivate(${existing.processId})`;
        await runProcess('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], process.cwd()).catch(() => undefined);
        sendJson(res, 200, { launched: executable, sketch: sketchPath, alreadyRunning: true, processId: existing.processId });
        return;
      }
      const child = spawn(executable, ['-f', resolveWorkspacePath('resources'), sketchPath], {
        cwd: dirname(sketchPath),
        detached: true,
        stdio: 'ignore'
      });
      child.unref();
      sendJson(res, 200, { launched: executable, sketch: sketchPath, alreadyRunning: false });
      return;
    }
    case 'POST /api/sketch/autowire': {
      const sketchPath = resolveWorkspacePath(requireParam(url, 'path'));
      // Start from a clean slate: remove every existing wire, then wire everything fresh.
      const originalXml = await readSketchModel(sketchPath);
      const xml = originalXml
        .replace(/\s*<instance\b[^>]*moduleIdRef="WireModuleID"[^>]*>[\s\S]*?<\/instance>/gi, '');

      const boolParam = (name: string, fallback: boolean): boolean => {
        const value = url.searchParams.get(name);
        return value === null ? fallback : value !== '0' && value.toLowerCase() !== 'false';
      };
      const numParam = (name: string, fallback: number): number => {
        const value = Number(url.searchParams.get(name));
        return Number.isFinite(value) && value > 0 ? value : fallback;
      };
      // Server-stored settings are the source of truth; query params can override per call.
      const stored = await loadAutowireSettings();
      const settings = {
        placeParts: boolParam('place', stored.placeParts),
        resetRotations: boolParam('resetRotation', stored.resetRotations),
        railJumpers: boolParam('jumpers', stored.railJumpers),
        wireSignals: boolParam('signals', stored.wireSignals),
        cleanOnly: boolParam('cleanOnly', stored.cleanOnly),
        boardGap: numParam('gap', stored.boardGap),
        partSpacing: numParam('spacing', stored.partSpacing)
      };
      // Clean-only keeps the existing nets and just re-places and re-routes them.
      const preservedConnections = settings.cleanOnly ? extractWireConnections(originalXml) : [];

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
      // Rail columns are picked by proximity: each part connects to the nearest free column.
      const railColumnX = new Map<number, number>();
      for (const column of railColumns) {
        const pin = await findPinPosition(breadboardFzp, `pin${column}W`);
        if (pin) railColumnX.set(column, breadboard.x + applyMat(breadboard.transform, pin).x);
      }
      const usedRailColumns = new Set<number>();
      // The last two columns are reserved for the rail-pair jumpers.
      const reservedLast = railColumns.at(-1);
      const reservedSecondLast = railColumns.at(-2);
      if (reservedLast !== undefined) usedRailColumns.add(reservedLast);
      if (reservedSecondLast !== undefined) usedRailColumns.add(reservedSecondLast);
      const nearestRailColumn = (sceneX: number): number => {
        let bestColumn = railColumns[0];
        let bestDistance = Infinity;
        for (const column of railColumns) {
          if (usedRailColumns.has(column)) continue;
          const x = railColumnX.get(column);
          if (x === undefined) continue;
          const distance = Math.abs(x - sceneX);
          if (distance < bestDistance) {
            bestDistance = distance;
            bestColumn = column;
          }
        }
        usedRailColumns.add(bestColumn);
        return bestColumn;
      };

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

      // Placement: anchor the breadboard, put the MCU below it and sensors in a row
      // above it so wire paths stay short and never need to cross the board.
      let workingXml = xml;
      const localBox = async (part: InstanceInfo): Promise<{ minX: number; minY: number; width: number; height: number } | undefined> => {
        const fzpPath = await findFzpByModuleId(part.moduleIdRef);
        if (!fzpPath) return undefined;
        const svg = await readPartImageSvg(fzpPath);
        const size = svg ? svgSizeToScene(svg) : undefined;
        if (!size) return undefined;
        const corners = [
          applyMat(part.transform, { x: 0, y: 0 }),
          applyMat(part.transform, { x: size.width, y: 0 }),
          applyMat(part.transform, { x: 0, y: size.height }),
          applyMat(part.transform, { x: size.width, y: size.height })
        ];
        const minX = Math.min(...corners.map(corner => corner.x));
        const minY = Math.min(...corners.map(corner => corner.y));
        return {
          minX,
          minY,
          width: Math.max(...corners.map(corner => corner.x)) - minX,
          height: Math.max(...corners.map(corner => corner.y)) - minY
        };
      };
      const moveTo = (part: InstanceInfo, box: { minX: number; minY: number }, targetX: number, targetY: number) => {
        part.x = targetX - box.minX;
        part.y = targetY - box.minY;
        workingXml = workingXml.replace(
          new RegExp(`(<instance\\b[^>]*modelIndex="${part.modelIndex}"[^>]*>[\\s\\S]*?<breadboardView[^>]*>[\\s\\S]*?<geometry\\b[^>]*?)\\bx="[^"]*"([^>]*?)\\by="[^"]*"`, 'i'),
          `$1x="${part.x}"$2y="${part.y}"`
        );
      };
      // Rotated parts have pins facing away from the board; restore natural orientation.
      const resetRotation = (part: InstanceInfo) => {
        if (part.transform === identityMat) return;
        part.transform = identityMat;
        workingXml = workingXml.replace(
          new RegExp(`(<instance\\b[^>]*modelIndex="${part.modelIndex}"[^>]*>[\\s\\S]*?<breadboardView[^>]*>[\\s\\S]*?)<transform\\b[^>]*\\/>\\s*`, 'i'),
          '$1'
        );
      };
      // Some parts are drawn with pins on the top edge; flip those 180 degrees so the
      // pins face the breadboard below the sensor row.
      const orientPinsDown = async (part: InstanceInfo) => {
        const fzpPath = await findFzpByModuleId(part.moduleIdRef);
        if (!fzpPath) return;
        const svg = await readPartImageSvg(fzpPath);
        const size = svg ? svgSizeToScene(svg) : undefined;
        if (!size) return;
        const definition = await readFile(fzpPath, 'utf8').catch(() => '');
        const ids = [...definition.matchAll(/<connector[^>]*\bid="([^"]+)"/gi)].map(match => match[1]);
        const ys: number[] = [];
        for (const id of ids) {
          const pin = await findPinPosition(fzpPath, id);
          if (pin) ys.push(pin.y);
        }
        if (ys.length === 0) return;
        const averageY = ys.reduce((sum, value) => sum + value, 0) / ys.length;
        if (averageY >= size.height / 2) return;
        part.transform = [-1, 0, 0, -1, size.width, size.height];
        workingXml = workingXml.replace(
          new RegExp(`(<instance\\b[^>]*modelIndex="${part.modelIndex}"[^>]*>[\\s\\S]*?<breadboardView[^>]*>[\\s\\S]*?<geometry\\b[^>]*\\/?>)`, 'i'),
          `$1\n                    <transform m11="-1" m12="0" m13="0" m21="0" m22="-1" m23="0" m31="${size.width}" m32="${size.height}" m33="1"/>`
        );
      };
      let boardCenterY: number | undefined;
      const breadboardLocal = await localBox(breadboard);
      if (breadboardLocal) {
        const boardX1 = breadboard.x + breadboardLocal.minX;
        const boardY1 = breadboard.y + breadboardLocal.minY;
        const boardX2 = boardX1 + breadboardLocal.width;
        const boardY2 = boardY1 + breadboardLocal.height;
        boardCenterY = (boardY1 + boardY2) / 2;
        void boardX2;
        const gap = settings.boardGap;
        if (settings.placeParts) {
          if (mcu) {
            if (settings.resetRotations) resetRotation(mcu);
            const box = await localBox(mcu);
            if (box) moveTo(mcu, box, boardX1, boardY2 + gap);
          }
          // Uniform layout: identical center-to-center pitch (widest part + spacing) and
          // identical bottom-edge distance above the board for every sensor.
          const sensorEntries: Array<{ part: InstanceInfo; box: { minX: number; minY: number; width: number; height: number } }> = [];
          for (const part of parts) {
            if (part === breadboard || part === mcu) continue;
            if (skipModules.test(part.moduleIdRef) || /breadboard/i.test(part.moduleIdRef)) continue;
            if (settings.resetRotations) {
              resetRotation(part);
              await orientPinsDown(part);
            }
            const box = await localBox(part);
            if (box) sensorEntries.push({ part, box });
          }
          const pitch = Math.max(0, ...sensorEntries.map(entry => entry.box.width)) + settings.partSpacing;
          sensorEntries.forEach(({ part, box }, index) => {
            const centerX = boardX1 + pitch / 2 + index * pitch;
            moveTo(part, box, centerX - box.width / 2, boardY1 - gap - box.height);
          });
        }
      }

      // Part bounding boxes are routing obstacles (breadboard, PCB, and notes excluded).
      const partBoxes = new Map<string, Rect>();
      for (const part of parts) {
        if (part === breadboard || skipModules.test(part.moduleIdRef) || /breadboard/i.test(part.moduleIdRef)) continue;
        const fzpPath = await findFzpByModuleId(part.moduleIdRef);
        if (!fzpPath) continue;
        const svg = await readPartImageSvg(fzpPath);
        const size = svg ? svgSizeToScene(svg) : undefined;
        if (!size) continue;
        const corners = [
          applyMat(part.transform, { x: 0, y: 0 }),
          applyMat(part.transform, { x: size.width, y: 0 }),
          applyMat(part.transform, { x: 0, y: size.height }),
          applyMat(part.transform, { x: size.width, y: size.height })
        ];
        partBoxes.set(part.modelIndex, {
          x1: part.x + Math.min(...corners.map(corner => corner.x)),
          y1: part.y + Math.min(...corners.map(corner => corner.y)),
          x2: part.x + Math.max(...corners.map(corner => corner.x)),
          y2: part.y + Math.max(...corners.map(corner => corner.y))
        });
      }
      const occupied = new Set<string>();
      // The breadboard is an obstacle too, except for wires that terminate on it.
      const breadboardSvg = await readPartImageSvg(breadboardFzp);
      const breadboardSize = breadboardSvg ? svgSizeToScene(breadboardSvg) : undefined;
      if (breadboardSize) {
        const corners = [
          applyMat(breadboard.transform, { x: 0, y: 0 }),
          applyMat(breadboard.transform, { x: breadboardSize.width, y: 0 }),
          applyMat(breadboard.transform, { x: 0, y: breadboardSize.height }),
          applyMat(breadboard.transform, { x: breadboardSize.width, y: breadboardSize.height })
        ];
        partBoxes.set(breadboard.modelIndex, {
          x1: breadboard.x + Math.min(...corners.map(corner => corner.x)),
          y1: breadboard.y + Math.min(...corners.map(corner => corner.y)),
          x2: breadboard.x + Math.max(...corners.map(corner => corner.x)),
          y2: breadboard.y + Math.max(...corners.map(corner => corner.y))
        });
      }
      const routeSmart = (options: {
        baseTitle: string;
        color: string;
        start: PinPosition;
        end: PinPosition;
        startTarget: WireEndTarget;
        endTarget: WireEndTarget;
        exclude: string[];
      }): string[] => {
        const obstacles = [...partBoxes.entries()]
          .filter(([modelIndex]) => !options.exclude.includes(modelIndex))
          .map(([, rect]) => rect);
        // Leave the pin with a straight vertical stub before any bend is allowed.
        const stubLength = 16;
        const verticalGap = options.end.y - options.start.y;
        const stub = Math.abs(verticalGap) > stubLength * 2 ? Math.sign(verticalGap) * stubLength : 0;
        const routeStart = stub ? { x: options.start.x, y: options.start.y + stub } : options.start;
        const points = findPath(routeStart, options.end, obstacles, occupied);
        if (points) {
          let full = stub ? [options.start, ...points] : points;
          // Merge collinear runs introduced by the stub.
          full = full.filter((point, index) => {
            if (index === 0 || index === full.length - 1) return true;
            const previous = full[index - 1];
            const next = full[index + 1];
            return !((previous.x === point.x && point.x === next.x) || (previous.y === point.y && point.y === next.y));
          });
          markOccupied(full, occupied);
          return chainWire(full, options.baseTitle, options.color, options.startTarget, options.endTarget);
        }
        return routeWire(options);
      };

      for (const part of settings.cleanOnly ? [] : parts) {
        if (part === breadboard) continue;
        if (skipModules.test(part.moduleIdRef) || /breadboard/i.test(part.moduleIdRef)) continue;
        const fzpPath = await findFzpByModuleId(part.moduleIdRef);
        if (!fzpPath) continue;
        const definition = await readFile(fzpPath, 'utf8').catch(() => '');
        const connectors = [...definition.matchAll(/<connector[^>]*id="([^"]+)"[^>]*name="([^"]+)"/gi)]
          .map(match => ({ id: match[1], name: match[2] }));
        // Prefer 5V over generic supply names over VIN; candidates within the best tier
        // are narrowed to the pin physically closest to the rail.
        const powerTiers = [/^(5v|\+5v)$/i, /^(vcc|vdd|vs|v|v\+|\+|pwr|power|3v3|3\.3v)$/i, /^vin$/i];
        // Pins inside an ICSP header group are programming pins, not supply cables.
        const isIcspNeighbor = (index: number): boolean => connectors
          .slice(Math.max(0, index - 3), index + 4)
          .some(connector => /icsp/i.test(connector.name));
        const withoutIcsp = (candidates: Array<{ id: string; name: string }>): Array<{ id: string; name: string }> => {
          const filtered = candidates.filter(candidate => !isIcspNeighbor(connectors.findIndex(c => c.id === candidate.id)));
          return filtered.length > 0 ? filtered : candidates;
        };
        const powerCandidates = withoutIcsp(powerTiers
          .map(tier => connectors.filter(connector => tier.test(connector.name)))
          .find(candidates => candidates.length > 0) ?? []);
        const groundCandidates = withoutIcsp(connectors.filter(connector => groundName.test(connector.name)));
        if (powerCandidates.length === 0 && groundCandidates.length === 0 && part !== mcu && mcuConnectors.length === 0) continue;

        const label = part.title || part.moduleIdRef;
        const scenePoint = (owner: InstanceInfo, pin: PinPosition) => {
          const mapped = applyMat(owner.transform, pin);
          return { x: owner.x + mapped.x, y: owner.y + mapped.y };
        };

        type PinChoice = { id: string; pin: PinPosition };
        const resolvePins = async (candidates: Array<{ id: string }>): Promise<PinChoice[]> => {
          const resolved = await Promise.all(candidates.map(async candidate => ({
            id: candidate.id,
            pin: await findPinPosition(fzpPath, candidate.id)
          })));
          return resolved.filter((entry): entry is PinChoice => entry.pin !== undefined);
        };
        const powerPins = await resolvePins(powerCandidates);
        const groundPins = await resolvePins(groundCandidates);

        // Pick the free rail column closest to the part's supply pins.
        const anchorPin = powerPins[0]?.pin ?? groundPins[0]?.pin;
        if (!anchorPin && powerCandidates.length === 0 && groundCandidates.length === 0) continue;
        const railColumn = anchorPin
          ? nearestRailColumn(scenePoint(part, anchorPin).x)
          : railColumns[0];
        // Parts above the board connect to the top rail pair (Y=+, Z=-); below uses W/X.
        const partBox = partBoxes.get(part.modelIndex);
        const topSide = boardCenterY !== undefined && partBox !== undefined && (partBox.y1 + partBox.y2) / 2 < boardCenterY;
        const railPlus = topSide ? `pin${railColumn}Y` : `pin${railColumn}W`;
        const railMinus = topSide ? `pin${railColumn}Z` : `pin${railColumn}X`;
        const [railPlusPin, railMinusPin] = await Promise.all([
          findPinPosition(breadboardFzp, railPlus),
          findPinPosition(breadboardFzp, railMinus)
        ]);

        // Among equivalent pins (e.g. the Uno's several GNDs), use the one nearest the rail.
        const closestTo = (choices: PinChoice[], target: PinPosition | undefined): PinChoice | undefined => {
          if (!target) return choices[0];
          const targetScene = scenePoint(breadboard, target);
          let best: PinChoice | undefined;
          let bestDistance = Infinity;
          for (const choice of choices) {
            const point = scenePoint(part, choice.pin);
            const distance = Math.abs(point.x - targetScene.x) + Math.abs(point.y - targetScene.y);
            if (distance < bestDistance) {
              bestDistance = distance;
              best = choice;
            }
          }
          return best;
        };
        const powerChoice = closestTo(powerPins, railPlusPin);
        const groundChoice = closestTo(groundPins, railMinusPin);
        const powerId = powerChoice?.id;
        const powerPin = powerChoice?.pin;
        const groundId = groundChoice?.id;
        const groundPin = groundChoice?.pin;

        if (powerId && powerPin && railPlusPin) {
          wireBlocks.push(...routeSmart({
            baseTitle: `AutoWire5V_${part.modelIndex}`,
            color: '#cc1414',
            start: scenePoint(part, powerPin),
            end: scenePoint(breadboard, railPlusPin),
            startTarget: { kind: 'part', modelIndex: part.modelIndex, connectorId: powerId },
            endTarget: { kind: 'breadboardPin', modelIndex: breadboard.modelIndex, connectorId: railPlus },
            exclude: [part.modelIndex, breadboard.modelIndex]
          }));
          wired.push({ from: `${label} ${powerId} (power)`, to: `Breadboard ${railPlus} (+ rail)` });
        }
        if (groundId && groundPin && railMinusPin) {
          wireBlocks.push(...routeSmart({
            baseTitle: `AutoWireGND_${part.modelIndex}`,
            color: '#404040',
            start: scenePoint(part, groundPin),
            end: scenePoint(breadboard, railMinusPin),
            startTarget: { kind: 'part', modelIndex: part.modelIndex, connectorId: groundId },
            endTarget: { kind: 'breadboardPin', modelIndex: breadboard.modelIndex, connectorId: railMinus },
            exclude: [part.modelIndex, breadboard.modelIndex]
          }));
          wired.push({ from: `${label} ${groundId} (ground)`, to: `Breadboard ${railMinus} (- rail)` });
        }

        // Remaining pins are signal lines: wire each to a free MCU pin (analog A*, else digital D2+).
        if (part !== mcu && mcu && mcuFzp && settings.wireSignals) {
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
            wireBlocks.push(...routeSmart({
              baseTitle: `AutoWireSig_${part.modelIndex}_${signal.id}`,
              color: signalColors[signalCount++ % signalColors.length],
              start: scenePoint(part, signalPin),
              end: scenePoint(mcu, mcuPinPosition),
              startTarget: { kind: 'part', modelIndex: part.modelIndex, connectorId: signal.id },
              endTarget: { kind: 'part', modelIndex: mcu.modelIndex, connectorId: mcuPin.id },
              exclude: [part.modelIndex, mcu.modelIndex]
            }));
            wired.push({ from: `${label} ${signal.name} (${signal.id})`, to: `${mcu.title || 'MCU'} ${mcuPin.name}` });
          }
        }
      }

      // Join the bottom rail pair (W=+, X=-) to the top pair (Y=+, Z=-): red on the
      // last column, black on the second-to-last so the jumpers do not overlap.
      const plusColumn = railColumns.at(-1);
      const minusColumn = railColumns.at(-2) ?? plusColumn;
      if (plusColumn !== undefined && minusColumn !== undefined && settings.railJumpers && !settings.cleanOnly) {
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

      // Clean-only: re-route the preserved connections without changing any net.
      if (settings.cleanOnly) {
        const scenePointOf = (owner: InstanceInfo, pin: PinPosition): PinPosition => {
          const mapped = applyMat(owner.transform, pin);
          return { x: owner.x + mapped.x, y: owner.y + mapped.y };
        };
        let keepIndex = 0;
        for (const connection of preservedConnections) {
          const [a, b] = connection.ends;
          const fromInst = instances.find(inst => inst.modelIndex === a.modelIndex);
          const toInst = instances.find(inst => inst.modelIndex === b.modelIndex);
          if (!fromInst || !toInst) continue;
          const [fromFzp, toFzp] = await Promise.all([
            findFzpByModuleId(fromInst.moduleIdRef),
            findFzpByModuleId(toInst.moduleIdRef)
          ]);
          if (!fromFzp || !toFzp) continue;
          const [fromPin, toPin] = await Promise.all([
            findPinPosition(fromFzp, a.connectorId),
            findPinPosition(toFzp, b.connectorId)
          ]);
          if (!fromPin || !toPin) continue;
          wireBlocks.push(...routeSmart({
            baseTitle: `AutoWireKeep_${keepIndex++}`,
            color: connection.color,
            start: scenePointOf(fromInst, fromPin),
            end: scenePointOf(toInst, toPin),
            startTarget: { kind: fromInst === breadboard ? 'breadboardPin' : 'part', modelIndex: a.modelIndex, connectorId: a.connectorId },
            endTarget: { kind: toInst === breadboard ? 'breadboardPin' : 'part', modelIndex: b.modelIndex, connectorId: b.connectorId },
            exclude: [a.modelIndex, b.modelIndex]
          }));
          wired.push({
            from: `${fromInst.title || fromInst.moduleIdRef} ${a.connectorId}`,
            to: `${toInst.title || toInst.moduleIdRef} ${b.connectorId} (kept)`
          });
        }
      }

      if (wireBlocks.length === 0) {
        throw new HttpError(404, 'No unwired parts with power/ground connectors were found.');
      }

      const updated = workingXml.replace(/<\/instances>/i, `${wireBlocks.join('')}\n    </instances>`);
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
