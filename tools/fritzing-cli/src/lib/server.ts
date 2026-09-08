import { readdir, readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { homedir } from 'node:os';
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

// Parts live in the external fritzing-parts repo, the app's bundled resources/parts,
// and the user's Fritzing data folder (custom/imported parts).
function getPartsRoots(): string[] {
  const roots = [getPartsRoot(), resolveWorkspacePath('resources/parts')];
  const documents = [
    process.env.FRITZING_USER_PARTS,
    process.env.OneDrive ? join(process.env.OneDrive, 'Documents', 'Fritzing', 'parts') : undefined,
    join(homedir(), 'Documents', 'Fritzing', 'parts')
  ];
  for (const candidate of documents) {
    if (candidate && !roots.includes(candidate)) roots.push(candidate);
  }
  return roots;
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
  // The svgId may be on a shape or a <g> wrapping shapes; attributes may precede the id,
  // so scan from the element's opening bracket.
  const idIndex = svg.search(new RegExp(`\\bid="${svgId}"`, 'i'));
  if (idIndex < 0) return undefined;
  const elementStart = svg.lastIndexOf('<', idIndex);
  const windowText = svg.slice(elementStart, idIndex + 800);
  let x: number | undefined;
  let y: number | undefined;
  const circle = windowText.match(/\bcx="([\d.-]+)"[^>]*\bcy="([\d.-]+)"/i);
  if (circle) {
    x = Number(circle[1]);
    y = Number(circle[2]);
  } else {
    const rect = windowText.match(/\bx="([\d.-]+)"[^>]*\by="([\d.-]+)"(?:[^>]*\bwidth="([\d.-]+)")?(?:[^>]*\bheight="([\d.-]+)")?/i);
    if (rect) {
      x = Number(rect[1]) + Number(rect[3] ?? 0) / 2;
      y = Number(rect[2]) + Number(rect[4] ?? 0) / 2;
    }
  }
  if (x === undefined || y === undefined || Number.isNaN(x) || Number.isNaN(y)) return undefined;
  // Map user units to scene units via the viewBox against the Fritzing-converted size.
  const viewBox = svg.match(/viewBox="([^"]+)"/i)?.[1]?.split(/\s+/).map(Number);
  const sceneSize = svgSizeToScene(svg);
  if (viewBox && sceneSize && viewBox[2] > 0) {
    const scale = sceneSize.width / viewBox[2];
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
      const parts: Array<{ moduleIdRef: string; title: string; x: number; y: number; z: number; width?: number; height?: number }> = [];
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
      // Start from a clean slate: remove every existing wire, then wire everything fresh.
      const xml = (await readSketchModel(sketchPath))
        .replace(/\s*<instance\b[^>]*moduleIdRef="WireModuleID"[^>]*>[\s\S]*?<\/instance>/gi, '');

      type InstanceInfo = { moduleIdRef: string; modelIndex: string; title: string; x: number; y: number };
      const instances: InstanceInfo[] = [];
      for (const match of xml.matchAll(/<instance\b([^>]*)>([\s\S]*?)<\/instance>/gi)) {
        const attrs = match[1] ?? '';
        const body = match[2] ?? '';
        const moduleIdRef = attrs.match(/\bmoduleIdRef="([^"]+)"/i)?.[1] ?? '';
        const modelIndex = attrs.match(/\bmodelIndex="([^"]+)"/i)?.[1] ?? '';
        const title = (body.match(/<title>([\s\S]*?)<\/title>/i)?.[1] ?? '').trim();
        const geometry = body.match(/<breadboardView[^>]*>[\s\S]*?<geometry\b([^>]*)\/?>/i)?.[1] ?? '';
        const x = Number(geometry.match(/\bx="([^"]+)"/i)?.[1] ?? '0');
        const y = Number(geometry.match(/\by="([^"]+)"/i)?.[1] ?? '0');
        instances.push({ moduleIdRef, modelIndex, title, x, y });
      }

      const skipModules = /^(WireModuleID|NoteModuleID|RulerModuleID|LogoImageModuleID|TwoLayerRectanglePCBModuleID)$/i;
      const breadboard = instances.find(instance => /breadboard/i.test(instance.moduleIdRef));
      if (!breadboard) throw new HttpError(404, 'No breadboard found in this sketch.');
      const breadboardFzp = await findFzpByModuleId(breadboard.moduleIdRef);
      if (!breadboardFzp) throw new HttpError(404, 'The breadboard part definition was not found.');

      const groundName = /^(gnd|ground|-|0v|vss)$/i;
      const wired: Array<{ from: string; to: string }> = [];
      const wireBlocks: string[] = [];
      // Each part gets its own rail column so wires do not stack.
      let railColumn = 5;

      for (const part of instances) {
        if (part === breadboard) continue;
        if (skipModules.test(part.moduleIdRef) || /breadboard/i.test(part.moduleIdRef)) continue;
        const fzpPath = await findFzpByModuleId(part.moduleIdRef);
        if (!fzpPath) continue;
        const definition = await readFile(fzpPath, 'utf8').catch(() => '');
        const connectors = [...definition.matchAll(/<connector[^>]*id="([^"]+)"[^>]*name="([^"]+)"/gi)]
          .map(match => ({ id: match[1], name: match[2] }));
        // Prefer 5V over generic supply names over VIN; last match wins within a tier (power headers are declared last).
        const powerTiers = [/^(5v|\+5v)$/i, /^(vcc|vdd|vs|v\+|\+|pwr|power|3v3|3\.3v)$/i, /^vin$/i];
        const powerId = powerTiers
          .map(tier => connectors.filter(connector => tier.test(connector.name)).at(-1)?.id)
          .find(id => id !== undefined);
        const groundId = connectors.filter(connector => groundName.test(connector.name)).at(-1)?.id;
        if (!powerId && !groundId) continue;

        const railPlus = `pin${railColumn}W`;
        const railMinus = `pin${railColumn}X`;
        const [powerPin, groundPin, railPlusPin, railMinusPin] = await Promise.all([
          powerId ? findPinPosition(fzpPath, powerId) : undefined,
          groundId ? findPinPosition(fzpPath, groundId) : undefined,
          findPinPosition(breadboardFzp, railPlus),
          findPinPosition(breadboardFzp, railMinus)
        ]);
        const label = part.title || part.moduleIdRef;

        if (powerId && powerPin && railPlusPin) {
          wireBlocks.push(buildWireInstance({
            title: `AutoWire5V_${part.modelIndex}`,
            color: '#cc1414',
            from: { modelIndex: part.modelIndex, x: part.x + powerPin.x, y: part.y + powerPin.y },
            fromConnect: { connectorId: powerId },
            to: { modelIndex: breadboard.modelIndex, connectorId: railPlus },
            toPoint: { x: breadboard.x + railPlusPin.x, y: breadboard.y + railPlusPin.y }
          }));
          wired.push({ from: `${label} ${powerId} (power)`, to: `Breadboard ${railPlus} (+ rail)` });
        }
        if (groundId && groundPin && railMinusPin) {
          wireBlocks.push(buildWireInstance({
            title: `AutoWireGND_${part.modelIndex}`,
            color: '#404040',
            from: { modelIndex: part.modelIndex, x: part.x + groundPin.x, y: part.y + groundPin.y },
            fromConnect: { connectorId: groundId },
            to: { modelIndex: breadboard.modelIndex, connectorId: railMinus },
            toPoint: { x: breadboard.x + railMinusPin.x, y: breadboard.y + railMinusPin.y }
          }));
          wired.push({ from: `${label} ${groundId} (ground)`, to: `Breadboard ${railMinus} (- rail)` });
        }
        if ((powerId && powerPin) || (groundId && groundPin)) {
          railColumn += 5;
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
