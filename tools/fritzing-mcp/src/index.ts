import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import AdmZip from 'adm-zip';
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { EOL } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as z from 'zod/v4';

const moduleDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(moduleDir, '../../..');
const sketchExtensions = new Set(['.fz', '.fzz']);

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
    lines.push('Bundle: .fzz archive. Use read_sketch_model to inspect its embedded .fz model.');
  }

  return lines.join(EOL);
}

function sketchModelEntry(archive: AdmZip): string {
  const entry = archive.getEntries().find(candidate => candidate.entryName.toLowerCase().endsWith('.fz'));
  if (!entry) {
    throw new Error('The .fzz package does not contain an embedded .fz sketch model.');
  }

  return entry.entryName;
}

async function readSketchModel(sketchPath: string): Promise<string> {
  const extension = extname(sketchPath).toLowerCase();
  if (extension === '.fz') {
    return readFile(sketchPath, 'utf8');
  }
  if (extension === '.fzz') {
    const archive = new AdmZip(sketchPath);
    return archive.readAsText(sketchModelEntry(archive));
  }

  throw new Error('Sketch path must end in .fz or .fzz.');
}

async function writeSketchModel(sketchPath: string, xml: string, createBackup: boolean): Promise<string> {
  const extension = extname(sketchPath).toLowerCase();
  if (extension !== '.fz' && extension !== '.fzz') {
    throw new Error('Sketch path must end in .fz or .fzz.');
  }
  if (xml.trim().length === 0) {
    throw new Error('Sketch XML must not be empty.');
  }
  if (!await exists(sketchPath)) {
    throw new Error(`Sketch file does not exist: ${sketchPath}`);
  }

  if (createBackup) {
    await copyFile(sketchPath, `${sketchPath}.bak`);
  }

  if (extension === '.fz') {
    await writeFile(sketchPath, xml, 'utf8');
    return sketchPath;
  }

  const archive = new AdmZip(sketchPath);
  archive.updateFile(sketchModelEntry(archive), Buffer.from(xml, 'utf8'));
  archive.writeZip(sketchPath);
  return sketchPath;
}

async function findParts(query: string, limit: number): Promise<Array<{ moduleId: string; title: string; path: string }>> {
  const partsRoot = getPartsRoot();
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

function getPartsRoot(): string {
  return process.env.FRITZING_PARTS_PATH ?? resolve(repoRoot, '../fritzing-parts');
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

server.registerTool(
  'help',
  {
    description: 'Describe the direct Fritzing MCP tools and repository paths.',
    inputSchema: z.object({})
  },
  async () => {
    const lines = [
      'Fritzing MCP Server',
      `Repository root: ${repoRoot}`,
      '',
      'Repository file tools:',
      '- read_file: path - read a UTF-8 file.',
      '- write_file: path, content, overwrite? - create or replace a UTF-8 file.',
      '- move_path: sourcePath, destinationPath, overwrite? - move or rename a file or folder.',
      '- delete_path: path, recursive? - delete a file or folder.',
      '',
      'External sketch tools:',
      '- list_sketches: folder?, limit? - list .fz and .fzz sketches.',
      '- inspect_sketch: sketchPath - read basic sketch metadata.',
      '- read_sketch_model: sketchPath - extract editable .fz XML from a .fz or .fzz package.',
      '- write_sketch_model: sketchPath, xml, createBackup? - update a .fz or embedded .fzz model.',
      '',
      'Parts tools:',
      '- find_parts: query, limit? - find installed part definitions and moduleIds.',
      '- update_parts_library: pull the configured fritzing-parts Git repository to get the newest official parts.',
      '',
      'Fritzing does not need to be running. Sketch tools directly edit .fz XML and the embedded .fz model in .fzz packages.',
      'Relative paths are resolved from the repository root. Repository file tools are restricted to this repository.'
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
  'read_sketch_model',
  {
    description: 'Read editable Fritzing .fz XML from a plain .fz file or the embedded model in a .fzz package without starting Fritzing.',
    inputSchema: z.object({
      sketchPath: z.string().describe('Absolute or repository-relative path to a .fz or .fzz sketch.')
    })
  },
  async ({ sketchPath }) => {
    const resolvedSketchPath = resolveWorkspacePath(sketchPath);
    return {
      content: [{ type: 'text', text: await readSketchModel(resolvedSketchPath) }]
    };
  }
);

server.registerTool(
  'write_sketch_model',
  {
    description: 'Update a plain .fz sketch or the embedded .fz model in a .fzz package without starting Fritzing. Creates a .bak copy by default.',
    inputSchema: z.object({
      sketchPath: z.string().describe('Absolute or repository-relative path to an existing .fz or .fzz sketch.'),
      xml: z.string().describe('Complete replacement .fz XML model.'),
      createBackup: z.boolean().default(true).describe('Create a <sketch>.bak copy before editing.')
    })
  },
  async ({ sketchPath, xml, createBackup }) => {
    const resolvedSketchPath = resolveWorkspacePath(sketchPath);
    const savedPath = await writeSketchModel(resolvedSketchPath, xml, createBackup);
    return {
      content: [{ type: 'text', text: `Updated sketch model: ${savedPath}${createBackup ? `${EOL}Backup: ${savedPath}.bak` : ''}` }]
    };
  }
);

server.registerTool(
  'update_parts_library',
  {
    description: 'Update the configured fritzing-parts Git repository from its remote using a fast-forward-only pull.',
    inputSchema: z.object({})
  },
  async () => {
    const partsRoot = getPartsRoot();
    if (!await exists(partsRoot)) {
      throw new Error(`Configured Fritzing parts repository does not exist: ${partsRoot}`);
    }

    const result = await runProcess('git', ['pull', '--ff-only'], partsRoot);
    const output = [
      `Parts repository: ${partsRoot}`,
      `Exit code: ${result.code}`,
      result.stdout.trim(),
      result.stderr.trim()
    ].filter(Boolean).join(EOL);

    return {
      content: [{ type: 'text', text: output }],
      isError: result.code !== 0
    };
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

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});