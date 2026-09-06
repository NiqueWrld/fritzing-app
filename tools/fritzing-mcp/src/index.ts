import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, copyFile, mkdir, readdir, readFile, stat } from 'node:fs/promises';
import { EOL } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path';
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