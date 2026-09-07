import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { EOL } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as z from 'zod/v4';

const moduleDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(moduleDir, '../../..');
const sketchExtensions = new Set(['.fz', '.fzz']);
const exportFlags = {
  svg: '-svg',
  gerber: '-g',
  all: '-all'
} as const;

type ExportFormat = keyof typeof exportFlags;
type SketchView = 'Breadboard' | 'Schematic' | 'PCB';
const defaultTestingPort = Number.parseInt(process.env.FRITZING_FTESTING_PORT ?? '17999', 10);

const server = new McpServer({
  name: 'fritzing-workspace',
  version: '0.1.0'
});

function resolveWorkspacePath(pathValue?: string): string {
  if (!pathValue || pathValue.trim().length === 0) {
    return repoRoot;
  }

  return isAbsolute(pathValue) ? pathValue : resolve(repoRoot, pathValue);
}

function resolveRepositoryPath(pathValue: string): string {
  const resolvedPath = resolveWorkspacePath(pathValue);
  const relativePath = relative(repoRoot, resolvedPath);
  if (relativePath.length === 0 || relativePath.startsWith('..') || isAbsolute(relativePath)) {
    throw new Error(`Path must be inside the Fritzing repository: ${pathValue}`);
  }

  return resolvedPath;
}

async function exists(pathValue: string): Promise<boolean> {
  try {
    await access(pathValue, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function findSketches(folder: string, limit: number, results: string[] = []): Promise<string[]> {
  if (results.length >= limit) {
    return results;
  }

  const entries = await readdir(folder, { withFileTypes: true });
  for (const entry of entries) {
    if (results.length >= limit) {
      break;
    }

    const entryPath = join(folder, entry.name);
    if (entry.isDirectory()) {
      await findSketches(entryPath, limit, results);
    } else if (entry.isFile() && sketchExtensions.has(extname(entry.name).toLowerCase())) {
      results.push(entryPath);
    }
  }

  return results;
}

async function findDefaultExecutable(): Promise<string | undefined> {
  const configuredExecutable = process.env.FRITZING_EXECUTABLE ?? process.env.FRITZING_EXE;
  if (configuredExecutable && await exists(configuredExecutable)) {
    return configuredExecutable;
  }

  const candidates = [
    'build/release/Fritzing.exe',
    'build/debug/Fritzing.exe',
    'debug/Fritzing.exe',
    'release/Fritzing.exe',
    'Fritzing.exe',
    'fritzing'
  ];

  for (const candidate of candidates) {
    const candidatePath = resolve(repoRoot, candidate);
    if (await exists(candidatePath)) {
      return candidatePath;
    }
  }

  return undefined;
}

async function readSketchSummary(sketchPath: string): Promise<string> {
  const extension = extname(sketchPath).toLowerCase();
  const fileStat = await stat(sketchPath);
  const lines = [
    `Path: ${sketchPath}`,
    `File: ${basename(sketchPath)}`,
    `Size: ${fileStat.size} bytes`,
    `Modified: ${fileStat.mtime.toISOString()}`
  ];

  if (extension === '.fz') {
    const xml = await readFile(sketchPath, 'utf8');
    const title = xml.match(/<title>([^<]+)<\/title>/i)?.[1];
    const instances = [...xml.matchAll(/<instance\b/gi)].length;
    const connectors = [...xml.matchAll(/<connector\b/gi)].length;

    if (title) {
      lines.push(`Title: ${title}`);
    }
    lines.push(`Instances: ${instances}`);
    lines.push(`Connector elements: ${connectors}`);
  } else {
    lines.push('Bundle: .fzz archive. Use Fritzing itself for full inspection/export.');
  }

  return lines.join(EOL);
}

async function listFilesByExtension(folder: string, extension: string): Promise<string[]> {
  const results: string[] = [];
  const entries = await readdir(folder, { withFileTypes: true });

  for (const entry of entries) {
    const entryPath = join(folder, entry.name);
    if (entry.isDirectory()) {
      results.push(...await listFilesByExtension(entryPath, extension));
    } else if (entry.isFile() && extname(entry.name).toLowerCase() === extension) {
      results.push(entryPath);
    }
  }

  return results;
}

async function findParts(query: string, limit: number): Promise<Array<{ moduleId: string; title: string; path: string }>> {
  const partsRoot = process.env.FRITZING_PARTS_PATH ?? resolve(repoRoot, '../fritzing-parts');
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return [];

  const matches: Array<{ moduleId: string; title: string; path: string }> = [];
  const entries = await readdir(partsRoot, { withFileTypes: true });
  const folders = entries.filter(entry => entry.isDirectory()).map(entry => join(partsRoot, entry.name));
  while (folders.length > 0 && matches.length < limit) {
    const folder = folders.pop();
    if (!folder) continue;
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      if (matches.length >= limit) break;
      const entryPath = join(folder, entry.name);
      if (entry.isDirectory()) {
        folders.push(entryPath);
        continue;
      }
      if (!entry.isFile() || extname(entry.name).toLowerCase() !== '.fzp') continue;

      const content = await readFile(entryPath, 'utf8');
      const moduleId = content.match(/<module\b[^>]*\bmoduleId="([^"]+)"/i)?.[1] ?? '';
      const title = content.match(/<title>([^<]+)<\/title>/i)?.[1] ?? entry.name;
      if (`${entry.name} ${moduleId} ${title}`.toLowerCase().includes(normalizedQuery)) {
        matches.push({ moduleId, title, path: entryPath });
      }
    }
  }
  return matches;
}

function testingRequest(probe: string, payload?: string, port = defaultTestingPort): Promise<string> {
  return new Promise((resolveRequest, reject) => {
    const mode = payload === undefined ? 'read' : `write/${encodeURIComponent(payload)}`;
    const request = `GET /${encodeURIComponent(probe)}/${mode} HTTP/1.0\r\nHost: 127.0.0.1\r\n\r\n`;
    const socket = connect({ host: '127.0.0.1', port });
    let response = '';
    socket.setTimeout(5000);
    socket.on('connect', () => socket.write(request));
    socket.on('data', chunk => { response += chunk.toString(); });
    socket.on('timeout', () => socket.destroy(new Error('Timed out waiting for Fritzing --ftesting service.')));
    socket.on('error', reject);
    socket.on('close', () => {
      const separator = response.indexOf('\r\n\r\n');
      const header = separator >= 0 ? response.slice(0, separator) : response;
      const body = separator >= 0 ? response.slice(separator + 4) : '';
      if (!header.startsWith('HTTP/1.0 200')) {
        reject(new Error(body || `Fritzing testing service returned: ${header.split('\r\n')[0]}`));
        return;
      }
      resolveRequest(body);
    });
  });
}

function runProcess(command: string, args: string[], cwd: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolveProcess, reject) => {
    const child = spawn(command, args, { cwd, shell: false, windowsHide: true });
    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code: number | null) => {
      resolveProcess({ code, stdout, stderr });
    });
  });
}

async function exportSketch(
  sketchPath: string,
  format: ExportFormat,
  outputDir?: string,
  fritzingExecutable?: string
): Promise<{ output: string; outputDir: string; code: number | null; isError: boolean }> {
  const resolvedSketch = resolveWorkspacePath(sketchPath);
  const resolvedOutput = resolveWorkspacePath(outputDir ?? 'tools/fritzing-mcp/out/export');
  const executable = fritzingExecutable ? resolveWorkspacePath(fritzingExecutable) : await findDefaultExecutable();

  if (!executable) {
    return {
      output: 'Cannot export because no Fritzing executable was found. Build Fritzing first or pass fritzingExecutable.',
      outputDir: resolvedOutput,
      code: null,
      isError: true
    };
  }

  await mkdir(resolvedOutput, { recursive: true });
  const stagedSketch = join(resolvedOutput, basename(resolvedSketch));
  if (resolve(stagedSketch) !== resolve(resolvedSketch)) {
    await copyFile(resolvedSketch, stagedSketch);
  }

  const args = [exportFlags[format], resolvedOutput];
  const result = await runProcess(executable, args, dirname(executable));
  const output = [
    `Command: ${executable} ${args.map(arg => JSON.stringify(arg)).join(' ')}`,
    `Exit code: ${result.code}`,
    `Output folder: ${resolvedOutput}`,
    result.stdout.trim() ? `stdout:${EOL}${result.stdout.trim()}` : '',
    result.stderr.trim() ? `stderr:${EOL}${result.stderr.trim()}` : ''
  ].filter(Boolean).join(EOL);

  return {
    output,
    outputDir: resolvedOutput,
    code: result.code,
    isError: result.code !== 0
  };
}

function selectSketchImage(svgFiles: string[], sketchPath: string, view: SketchView): string | undefined {
  const sketchBaseName = basename(sketchPath, extname(sketchPath)).toLowerCase();
  const viewName = view.toLowerCase();

  return svgFiles.find(filePath => {
    const fileName = basename(filePath).toLowerCase();
    return fileName.startsWith(sketchBaseName) && fileName.includes(viewName);
  }) ?? svgFiles.find(filePath => basename(filePath).toLowerCase().includes(viewName)) ?? svgFiles[0];
}

server.registerTool(
  'help',
  {
    description: 'Describe the Fritzing MCP tools, paths, and local executable status.',
    inputSchema: z.object({})
  },
  async () => {
    const executable = await findDefaultExecutable();
    const lines = [
      'Fritzing MCP Server',
      `Repository root: ${repoRoot}`,
      `Fritzing executable: ${executable ?? 'not found'}`,
      '',
      'Repository file tools:',
      '- read_file: path - read a UTF-8 file.',
      '- write_file: path, content, overwrite? - create or replace a UTF-8 file.',
      '- move_path: sourcePath, destinationPath, overwrite? - move or rename a file or folder.',
      '- delete_path: path, recursive? - delete a file or folder.',
      '',
      'Sketch and export tools:',
      '- list_sketches: folder?, limit? - list .fz and .fzz sketches.',
      '- inspect_sketch: sketchPath - read basic sketch metadata.',
      '- locate_fritzing_executable: find the configured or local Fritzing executable.',
      '- export_sketch: sketchPath, format, outputDir?, fritzingExecutable? - export svg, gerber, or all.',
      '- render_sketch_image: sketchPath, view?, outputDir?, fritzingExecutable? - render Breadboard, Schematic, or PCB SVG.',
      '',
      'Parts and live editor tools:',
      '- find_parts: query, limit? - find installed part definitions and moduleIds.',
      '- place_part: moduleId, port? - place a library part in the active Fritzing editor.',
      '- get_live_sketch_xml: port? - return the active editor sketch XML.',
      '- edit_live_part: operation, parameters, port? - use PartProbe operations: getPosition, movePart, movePartRelative, getSize, getResizeHandlePos, sceneToScreen, getGridSize.',
      '- edit_live_wire: operation, parameters, port? - use WireProbe operations to inspect, move, or delete wires.',
      '',
      'Relative paths are resolved from the repository root. File editing tools are restricted to this repository.',
      'Live editor workflow: start Fritzing with --ftesting, use find_parts to obtain moduleIds, use place_part, then inspect/edit with the PartProbe and WireProbe tools.',
      'Live editor tools require Fritzing launched with --ftesting, which listens on port 17999 by default.'
    ];

    return {
      content: [{ type: 'text', text: lines.join(EOL) }]
    };
  }
);

server.registerTool(
  'read_file',
  {
    description: 'Read a UTF-8 text file from the Fritzing repository.',
    inputSchema: z.object({
      path: z.string().describe('File path relative to the Fritzing repository root.')
    })
  },
  async ({ path }) => {
    const filePath = resolveRepositoryPath(path);
    return {
      content: [{ type: 'text', text: await readFile(filePath, 'utf8') }]
    };
  }
);

server.registerTool(
  'write_file',
  {
    description: 'Create or replace a UTF-8 text file in the Fritzing repository.',
    inputSchema: z.object({
      path: z.string().describe('File path relative to the Fritzing repository root.'),
      content: z.string().describe('Complete UTF-8 file content to write.'),
      overwrite: z.boolean().default(false).describe('Allow replacing an existing file.')
    })
  },
  async ({ path, content, overwrite }) => {
    const filePath = resolveRepositoryPath(path);
    if (await exists(filePath) && !overwrite) {
      throw new Error(`Refusing to replace existing file without overwrite=true: ${path}`);
    }

    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, content, 'utf8');
    return {
      content: [{ type: 'text', text: `Wrote ${filePath}` }]
    };
  }
);

server.registerTool(
  'move_path',
  {
    description: 'Move or rename a file or folder inside the Fritzing repository.',
    inputSchema: z.object({
      sourcePath: z.string().describe('Existing path relative to the Fritzing repository root.'),
      destinationPath: z.string().describe('Destination path relative to the Fritzing repository root.'),
      overwrite: z.boolean().default(false).describe('Allow replacing an existing destination path.')
    })
  },
  async ({ sourcePath, destinationPath, overwrite }) => {
    const source = resolveRepositoryPath(sourcePath);
    const destination = resolveRepositoryPath(destinationPath);
    if (!await exists(source)) {
      throw new Error(`Source path does not exist: ${sourcePath}`);
    }
    if (await exists(destination)) {
      if (!overwrite) {
        throw new Error(`Destination already exists; pass overwrite=true to replace it: ${destinationPath}`);
      }
      await rm(destination, { recursive: true, force: true });
    }

    await mkdir(dirname(destination), { recursive: true });
    await rename(source, destination);
    return {
      content: [{ type: 'text', text: `Moved ${source} to ${destination}` }]
    };
  }
);

server.registerTool(
  'delete_path',
  {
    description: 'Delete a file or folder from the Fritzing repository.',
    inputSchema: z.object({
      path: z.string().describe('Path relative to the Fritzing repository root.'),
      recursive: z.boolean().default(false).describe('Allow deleting a non-empty folder.')
    })
  },
  async ({ path, recursive }) => {
    const targetPath = resolveRepositoryPath(path);
    if (!await exists(targetPath)) {
      throw new Error(`Path does not exist: ${path}`);
    }

    await rm(targetPath, { recursive, force: true });
    return {
      content: [{ type: 'text', text: `Deleted ${targetPath}` }]
    };
  }
);

server.registerTool(
  'find_parts',
  {
    description: 'Find installed Fritzing part definitions by filename, title, or moduleId.',
    inputSchema: z.object({
      query: z.string().describe('Part name, title, or moduleId search text.'),
      limit: z.number().int().min(1).max(100).default(25).describe('Maximum matching parts to return.')
    })
  },
  async ({ query, limit }) => {
    const parts = await findParts(query, limit);
    return {
      content: [{
        type: 'text',
        text: parts.length > 0
          ? parts.map(part => `${part.title}${EOL}moduleId: ${part.moduleId}${EOL}path: ${part.path}`).join(`${EOL}${EOL}`)
          : `No installed Fritzing parts matched '${query}'.`
      }]
    };
  }
);

server.registerTool(
  'place_part',
  {
    description: 'Place a real library part into the active Fritzing Breadboard, Schematic, or PCB view. Requires Fritzing started with --ftesting.',
    inputSchema: z.object({
      moduleId: z.string().describe('The Fritzing moduleId to place. Use find_parts when needed.'),
      port: z.number().int().min(1).max(65535).optional().describe('Fritzing --ftesting port; defaults to FRITZING_FTESTING_PORT or 17999.')
    })
  },
  async ({ moduleId, port }) => {
    await testingRequest('DropByModuleID', moduleId, port);
    return {
      content: [{ type: 'text', text: `Requested placement of ${moduleId} in the active Fritzing view.` }]
    };
  }
);

server.registerTool(
  'get_live_sketch_xml',
  {
    description: 'Read the current live Fritzing sketch model XML. Requires Fritzing started with --ftesting.',
    inputSchema: z.object({
      port: z.number().int().min(1).max(65535).optional().describe('Fritzing --ftesting port; defaults to FRITZING_FTESTING_PORT or 17999.')
    })
  },
  async ({ port }) => ({
    content: [{ type: 'text', text: await testingRequest('CurrentSketchXml', undefined, port) }]
  })
);

server.registerTool(
  'edit_live_part',
  {
    description: 'Inspect or move a part in the active Fritzing view using the live PartProbe. Requires Fritzing started with --ftesting.',
    inputSchema: z.object({
      operation: z.enum(['getPosition', 'movePart', 'movePartRelative', 'getSize', 'getResizeHandlePos', 'sceneToScreen', 'getGridSize']).describe('PartProbe operation.'),
      parameters: z.record(z.string(), z.unknown()).default({}).describe('Operation data, such as {part, x, y}, forwarded to Fritzing.'),
      port: z.number().int().min(1).max(65535).optional().describe('Fritzing --ftesting port; defaults to FRITZING_FTESTING_PORT or 17999.')
    })
  },
  async ({ operation, parameters, port }) => {
    const result = await testingRequest('PartProbe', JSON.stringify({ cmd: operation, ...parameters }), port);
    return { content: [{ type: 'text', text: result }] };
  }
);

server.registerTool(
  'edit_live_wire',
  {
    description: 'Inspect, move, or delete wires in the active Fritzing view using the live WireProbe. Requires Fritzing started with --ftesting.',
    inputSchema: z.object({
      operation: z.enum(['getWires', 'getConnections', 'getWireInfo', 'getWireStartPos', 'getWireEndPos', 'getConnectorScenePos', 'sceneToScreen', 'isBigDotStart', 'isBigDotEnd', 'moveWireEnd', 'moveWireStart', 'moveWireEndRelative', 'moveWireStartRelative', 'moveWireNearEnd', 'moveWireNearStart', 'deleteWire', 'deleteUpToBendpoint']).describe('WireProbe operation.'),
      parameters: z.record(z.string(), z.unknown()).default({}).describe('Operation data forwarded to Fritzing.'),
      port: z.number().int().min(1).max(65535).optional().describe('Fritzing --ftesting port; defaults to FRITZING_FTESTING_PORT or 17999.')
    })
  },
  async ({ operation, parameters, port }) => {
    const result = await testingRequest('WireProbe', JSON.stringify({ cmd: operation, ...parameters }), port);
    return { content: [{ type: 'text', text: result }] };
  }
);

server.registerTool(
  'list_sketches',
  {
    description: 'List Fritzing sketch files in this workspace or a selected folder.',
    inputSchema: z.object({
      folder: z.string().optional().describe('Folder to search, relative to the workspace root unless absolute.'),
      limit: z.number().int().min(1).max(200).default(50).describe('Maximum number of sketches to return.')
    })
  },
  async ({ folder, limit }) => {
    const searchRoot = resolveWorkspacePath(folder ?? 'sketches');
    const sketches = await findSketches(searchRoot, limit);
    return {
      content: [
        {
          type: 'text',
          text: sketches.length > 0 ? sketches.join(EOL) : `No .fz or .fzz sketches found under ${searchRoot}`
        }
      ]
    };
  }
);

server.registerTool(
  'inspect_sketch',
  {
    description: 'Return basic metadata for a Fritzing .fz or .fzz sketch.',
    inputSchema: z.object({
      sketchPath: z.string().describe('Sketch path, relative to the workspace root unless absolute.')
    })
  },
  async ({ sketchPath }) => ({
    content: [{ type: 'text', text: await readSketchSummary(resolveWorkspacePath(sketchPath)) }]
  })
);

server.registerTool(
  'locate_fritzing_executable',
  {
    description: 'Find a likely Fritzing executable produced by a local build.',
    inputSchema: z.object({})
  },
  async () => {
    const executable = await findDefaultExecutable();
    return {
      content: [
        {
          type: 'text',
          text: executable ?? 'No Fritzing executable was found in the usual local build folders. Pass fritzingExecutable to export_sketch.'
        }
      ]
    };
  }
);

server.registerTool(
  'export_sketch',
  {
    description: 'Export a Fritzing sketch by invoking the local Fritzing command-line export service.',
    inputSchema: z.object({
      sketchPath: z.string().describe('Sketch path, relative to the workspace root unless absolute.'),
      format: z.enum(['svg', 'gerber', 'all']).describe('Export format to request from Fritzing. Use all to include BOM and IPC output.'),
      outputDir: z.string().optional().describe('Output folder. Defaults to tools/fritzing-mcp/out/export.'),
      fritzingExecutable: z.string().optional().describe('Path to the Fritzing executable. Defaults to a local build if found.')
    })
  },
  async ({ sketchPath, format, outputDir, fritzingExecutable }: { sketchPath: string; format: ExportFormat; outputDir?: string; fritzingExecutable?: string }) => {
    const result = await exportSketch(sketchPath, format, outputDir, fritzingExecutable);

    return {
      content: [{ type: 'text', text: result.output }],
      isError: result.isError
    };
  }
);

server.registerTool(
  'render_sketch_image',
  {
    description: 'Render a Fritzing sketch view to SVG and return it as MCP image content.',
    inputSchema: z.object({
      sketchPath: z.string().describe('Sketch path, relative to the workspace root unless absolute.'),
      view: z.enum(['Breadboard', 'Schematic', 'PCB']).default('Breadboard').describe('Sketch view image to return.'),
      outputDir: z.string().optional().describe('Output folder. Defaults to tools/fritzing-mcp/out/render.'),
      fritzingExecutable: z.string().optional().describe('Path to the Fritzing executable. Defaults to a local build if found.')
    })
  },
  async ({ sketchPath, view, outputDir, fritzingExecutable }: { sketchPath: string; view: SketchView; outputDir?: string; fritzingExecutable?: string }) => {
    const result = await exportSketch(sketchPath, 'svg', outputDir ?? 'tools/fritzing-mcp/out/render', fritzingExecutable);
    if (result.isError) {
      return {
        content: [{ type: 'text', text: result.output }],
        isError: true
      };
    }

    const svgFiles = await listFilesByExtension(result.outputDir, '.svg');
    const imagePath = selectSketchImage(svgFiles, sketchPath, view);
    if (!imagePath) {
      return {
        content: [{ type: 'text', text: `Fritzing export completed, but no SVG image was found in ${result.outputDir}.${EOL}${result.output}` }],
        isError: true
      };
    }

    const imageData = await readFile(imagePath, 'base64');
    return {
      content: [
        { type: 'text', text: `Rendered ${view} image: ${imagePath}` },
        { type: 'image', mimeType: 'image/svg+xml', data: imageData }
      ]
    };
  }
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});