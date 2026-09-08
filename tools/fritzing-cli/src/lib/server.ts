import { readdir, readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { basename, dirname, extname, join } from 'node:path';
import {
  findParts,
  findSketches,
  getPartsRoot,
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

// Parts live in the external fritzing-parts repo and the app's bundled resources/parts.
function getPartsRoots(): string[] {
  return [getPartsRoot(), resolveWorkspacePath('resources/parts')];
}

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

async function readPartImageSvg(fzpPath: string): Promise<string | undefined> {
  const fzp = await readFile(fzpPath, 'utf8').catch(() => undefined);
  if (!fzp) return undefined;
  const image = fzp.match(/<breadboardView\b[^>]*>[\s\S]*?<layers[^>]*\bimage="([^"]+)"/i)?.[1];
  if (!image) return undefined;
  const family = basename(dirname(fzpPath));
  for (const root of getPartsRoots()) {
    for (const candidate of [join(root, 'svg', family, image), join(root, 'svg', 'core', image)]) {
      const svg = await readFile(candidate, 'utf8').catch(() => undefined);
      if (svg) return svg;
    }
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
  const element = svg.match(new RegExp(`<[a-z]+\\b[^>]*\\bid="${svgId}"[^>]*>`, 'i'))?.[0];
  if (!element) return undefined;
  const attr = (name: string) => {
    const value = element.match(new RegExp(`\\b${name}="([^"]+)"`, 'i'))?.[1];
    return value === undefined ? undefined : Number(value);
  };
  let x: number | undefined;
  let y: number | undefined;
  const cx = attr('cx');
  const cy = attr('cy');
  if (cx !== undefined && cy !== undefined) {
    x = cx;
    y = cy;
  } else {
    const rx = attr('x');
    const ry = attr('y');
    const width = attr('width') ?? 0;
    const height = attr('height') ?? 0;
    if (rx !== undefined && ry !== undefined) {
      x = rx + width / 2;
      y = ry + height / 2;
    }
  }
  if (x === undefined || y === undefined) return undefined;
  // Map user units to scene units via the SVG's viewBox/width ratio.
  const viewBox = svg.match(/viewBox="([^"]+)"/i)?.[1]?.split(/\s+/).map(Number);
  const widthAttr = svg.match(/<svg[^>]*\bwidth="([\d.]+)(in|px)?"/i);
  if (viewBox && widthAttr) {
    const widthValue = Number(widthAttr[1]);
    const widthScene = widthAttr[2] === 'in' ? widthValue * SVG_DPI : widthValue * (SVG_DPI / 96);
    const scale = widthScene / viewBox[2];
    return { x: x * scale, y: y * scale };
  }
  return { x, y };
}

function buildWireInstance(options: {
  title: string;
  color: string;
  from: { modelIndex: string; x: number; y: number };
  to: { modelIndex: string; connectorId: string };
  fromConnect: { connectorId: string };
  toPoint: { x: number; y: number };
}): string {
  const { title, color, from, to, fromConnect, toPoint } = options;
  const dx = toPoint.x - from.x;
  const dy = toPoint.y - from.y;
  return `
        <instance moduleIdRef="WireModuleID" modelIndex="${Math.floor(Math.random() * 900000) + 100000}" path=":/resources/parts/core/wire.fzp">
            <title>${title}</title>
            <views>
                <breadboardView layer="breadboardWire">
                    <geometry z="3.5" x="${from.x}" y="${from.y}" x1="0" y1="0" x2="${dx}" y2="${dy}" wireFlags="64"/>
                    <wireExtras mils="22.2222" color="${color}" opacity="1" banded="0"/>
                    <connectors>
                        <connector connectorId="connector0" layer="breadboardWire">
                            <geometry x="0" y="0"/>
                            <connects>
                                <connect connectorId="${fromConnect.connectorId}" modelIndex="${from.modelIndex}" layer="breadboardbreadboard"/>
                            </connects>
                        </connector>
                        <connector connectorId="connector1" layer="breadboardWire">
                            <geometry x="0" y="0"/>
                            <connects>
                                <connect connectorId="${to.connectorId}" modelIndex="${to.modelIndex}" layer="breadboardbreadboard"/>
                            </connects>
                        </connector>
                    </connectors>
                </breadboardView>
            </views>
        </instance>`;
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
      const parts: Array<{ moduleIdRef: string; title: string; x: number; y: number; z: number }> = [];
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
          parts.push({ moduleIdRef, title, x, y, z: num('z') });
        }
      }
      parts.sort((a, b) => a.z - b.z);
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
      const candidates = getPartsRoots().flatMap(root => [
        join(root, 'svg', family, image),
        join(root, 'svg', 'core', image)
      ]);
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
      const xml = await readSketchModel(sketchPath);

      type InstanceInfo = { moduleIdRef: string; modelIndex: string; x: number; y: number };
      const findInstance = (pattern: RegExp): InstanceInfo | undefined => {
        for (const match of xml.matchAll(/<instance\b([^>]*)>([\s\S]*?)<\/instance>/gi)) {
          const attrs = match[1] ?? '';
          const body = match[2] ?? '';
          const moduleIdRef = attrs.match(/\bmoduleIdRef="([^"]+)"/i)?.[1] ?? '';
          if (!pattern.test(moduleIdRef)) continue;
          const modelIndex = attrs.match(/\bmodelIndex="([^"]+)"/i)?.[1] ?? '';
          const geometry = body.match(/<breadboardView[^>]*>[\s\S]*?<geometry\b([^>]*)\/?>/i)?.[1] ?? '';
          const x = Number(geometry.match(/\bx="([^"]+)"/i)?.[1] ?? '0');
          const y = Number(geometry.match(/\by="([^"]+)"/i)?.[1] ?? '0');
          return { moduleIdRef, modelIndex, x, y };
        }
        return undefined;
      };

      const uno = findInstance(/arduino_uno/i);
      const breadboard = findInstance(/breadboard/i);
      if (!uno) throw new HttpError(404, 'No Arduino Uno found in this sketch.');
      if (!breadboard) throw new HttpError(404, 'No breadboard found in this sketch.');

      const unoFzp = await findFzpByModuleId(uno.moduleIdRef);
      const breadboardFzp = await findFzpByModuleId(breadboard.moduleIdRef);
      if (!unoFzp || !breadboardFzp) throw new HttpError(404, 'Part definitions for the Uno or breadboard were not found.');

      // Power header pins are the last 5V/GND connectors declared in the Uno fzp.
      const unoDefinition = await readFile(unoFzp, 'utf8');
      const named = (name: string) => [...unoDefinition.matchAll(/<connector[^>]*id="([^"]+)"[^>]*name="([^"]+)"/gi)]
        .filter(match => match[2] === name)
        .map(match => match[1]);
      const fiveVoltId = named('5V').at(-1);
      const groundId = named('GND').at(-1);
      if (!fiveVoltId || !groundId) throw new HttpError(404, 'The Uno part has no 5V/GND connectors.');

      const railPlus = 'pin5W';
      const railMinus = 'pin5X';
      const [fiveVoltPin, groundPin, railPlusPin, railMinusPin] = await Promise.all([
        findPinPosition(unoFzp, fiveVoltId),
        findPinPosition(unoFzp, groundId),
        findPinPosition(breadboardFzp, railPlus),
        findPinPosition(breadboardFzp, railMinus)
      ]);
      if (!fiveVoltPin || !groundPin || !railPlusPin || !railMinusPin) {
        throw new HttpError(500, 'Could not resolve pin positions from the part SVGs.');
      }

      const wires = [
        buildWireInstance({
          title: 'AutoWire5V',
          color: '#cc1414',
          from: { modelIndex: uno.modelIndex, x: uno.x + fiveVoltPin.x, y: uno.y + fiveVoltPin.y },
          fromConnect: { connectorId: fiveVoltId },
          to: { modelIndex: breadboard.modelIndex, connectorId: railPlus },
          toPoint: { x: breadboard.x + railPlusPin.x, y: breadboard.y + railPlusPin.y }
        }),
        buildWireInstance({
          title: 'AutoWireGND',
          color: '#404040',
          from: { modelIndex: uno.modelIndex, x: uno.x + groundPin.x, y: uno.y + groundPin.y },
          fromConnect: { connectorId: groundId },
          to: { modelIndex: breadboard.modelIndex, connectorId: railMinus },
          toPoint: { x: breadboard.x + railMinusPin.x, y: breadboard.y + railMinusPin.y }
        })
      ].join('');

      const updated = xml.replace(/<\/instances>/i, `${wires}\n    </instances>`);
      if (updated === xml) throw new HttpError(500, 'Could not insert wires into the sketch.');
      await writeSketchModel(sketchPath, updated, true);
      sendJson(res, 200, {
        wired: [
          { from: `Uno ${fiveVoltId} (5V)`, to: `Breadboard ${railPlus} (+ rail)` },
          { from: `Uno ${groundId} (GND)`, to: `Breadboard ${railMinus} (- rail)` }
        ]
      });
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
