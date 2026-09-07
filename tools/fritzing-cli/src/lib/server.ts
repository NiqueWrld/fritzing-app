import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import {
  findParts,
  findSketches,
  getProjectLiveFolder,
  listPartsInSketch,
  listRunningFritzingInstances,
  readSketchModel,
  readSketchSummary,
  resolveWorkspacePath,
  snapshotProject
} from './cli.js';

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
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
    case 'GET /api/instances': {
      sendJson(res, 200, { instances: await listRunningFritzingInstances() });
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
