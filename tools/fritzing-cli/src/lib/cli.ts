#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import AdmZip from 'adm-zip';
import { spawn } from 'node:child_process';
import { constants, watch } from 'node:fs';
import { access, copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { EOL } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as z from 'zod/v4';
import { startHttpServer } from './server.js';

const moduleDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(moduleDir, '../../../..');
const sketchExtensions = new Set(['.fz', '.fzz', '.bak']);

function normalizeSketchExtension(sketchPath: string): string {
  const normalized = sketchPath.toLowerCase();
  if (normalized.endsWith('.fzz.bak')) {
    return '.fzz';
  }
  if (normalized.endsWith('.fz.bak')) {
    return '.fz';
  }
  return extname(sketchPath).toLowerCase();
}

const server = new McpServer({
  name: 'fritzing-workspace',
  version: '0.1.0'
});

export function resolveWorkspacePath(pathValue?: string): string {
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

export async function findSketches(folder: string, limit: number, results: string[] = []): Promise<string[]> {
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

export async function readSketchSummary(sketchPath: string): Promise<string> {
  const extension = normalizeSketchExtension(sketchPath);
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

export async function readSketchModel(sketchPath: string): Promise<string> {
  const extension = normalizeSketchExtension(sketchPath);
  if (extension === '.fz') {
    return readFile(sketchPath, 'utf8');
  }
  if (extension === '.fzz') {
    const archive = new AdmZip(sketchPath);
    return archive.readAsText(sketchModelEntry(archive));
  }

  throw new Error('Sketch path must end in .fz, .fzz, or a backup such as .fz.bak or .fzz.bak.');
}

async function writeSketchModel(sketchPath: string, xml: string, createBackup: boolean): Promise<string> {
  const extension = normalizeSketchExtension(sketchPath);
  if (extension !== '.fz' && extension !== '.fzz') {
    throw new Error('Sketch path must end in .fz, .fzz, or a backup such as .fz.bak or .fzz.bak.');
  }
  if (xml.trim().length === 0) {
    throw new Error('Sketch XML must not be empty.');
  }
  if (!await exists(sketchPath)) {
    throw new Error(`Sketch file does not exist: ${sketchPath}`);
  }

  if (createBackup && !sketchPath.toLowerCase().endsWith('.bak')) {
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

export async function findParts(query: string, limit: number): Promise<Array<{ moduleId: string; title: string; path: string }>> {
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

export function getPartsRoot(): string {
  return process.env.FRITZING_PARTS_PATH ?? resolve(repoRoot, '../fritzing-parts');
}

export function runProcess(command: string, args: string[], cwd: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
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

type FritzingInstance = {
  processId: number;
  executablePath: string;
  commandLine: string;
  windowTitle: string;
};

export async function listRunningFritzingInstances(): Promise<FritzingInstance[]> {
  if (process.platform !== 'win32') {
    throw new Error('running-instances is currently supported on Windows only.');
  }

  const script = [
    "$processes = Get-CimInstance Win32_Process -Filter \"Name = 'Fritzing.exe'\" | ForEach-Object {",
    '  [PSCustomObject]@{',
    '    processId = $_.ProcessId',
    '    executablePath = $_.ExecutablePath',
    '    commandLine = $_.CommandLine',
    '    windowTitle = $_.MainWindowTitle',
    '  }',
    '}',
    '$processes | ConvertTo-Json -Compress'
  ].join(EOL);
  const result = await runProcess('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], process.cwd());
  if (result.code !== 0) {
    throw new Error(`Unable to inspect Fritzing processes: ${result.stderr.trim() || result.stdout.trim()}`);
  }

  const output = result.stdout.trim();
  if (!output || output === 'null') {
    return [];
  }

  const parsed: unknown = JSON.parse(output);
  const records = Array.isArray(parsed) ? parsed : [parsed];
  return records.map((record): FritzingInstance => {
    const item = record as Partial<FritzingInstance>;
    return {
      processId: Number(item.processId),
      executablePath: item.executablePath ?? '(unavailable)',
      commandLine: item.commandLine ?? '(unavailable)',
      windowTitle: item.windowTitle ?? ''
    };
  });
}

server.registerTool(
  'help',
  {
    description: 'Describe the Fritzing CLI tools and repository paths.',
    inputSchema: z.object({})
  },
  async () => {
    const lines = [
      'Fritzing CLI',
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
      'Process tools:',
      '- running-instances: list active Windows Fritzing processes, including their PID, executable path, and launch command.',
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

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function ensureInstancesElement(xml: string): string {
  if (/<instances\s*>/i.test(xml)) {
    return xml;
  }

  const match = /<module\b[^>]*>([\s\S]*?)<\/module>/i.exec(xml);
  if (!match) {
    throw new Error('The sketch XML does not contain a valid <module> root.');
  }

  return xml.replace(/<module\b[^>]*>/i, '$&\n    <instances>\n    </instances>');
}

function addPartToSketchXml(xml: string, options: {
  moduleIdRef: string;
  title: string;
  x?: number;
  y?: number;
  path?: string;
  instanceName?: string;
  view?: string;
}): string {
  const title = options.title || 'Part';
  const moduleIdRef = options.moduleIdRef || 'generic-part';
  const view = options.view || 'breadboardView';
  const x = options.x ?? 0;
  const y = options.y ?? 0;
  const instanceName = options.instanceName || `${title.replace(/\s+/g, '')}${Math.floor(Math.random() * 10000)}`;
  const path = options.path || `${moduleIdRef}.fzp`;
  const xmlWithInstances = ensureInstancesElement(xml);
  const block = `
        <instance moduleIdRef="${escapeXml(moduleIdRef)}" modelIndex="${Math.floor(Math.random() * 100000)}" path="${escapeXml(path)}">
            <title>${escapeXml(title)}</title>
            <instanceName>${escapeXml(instanceName)}</instanceName>
            <views>
                <${view}>
                    <geometry z="3.5" x="${x}" y="${y}"/> 
                </${view}>
            </views>
        </instance>`;

  const result = xmlWithInstances.replace(/<instances\s*>/i, `<instances>${block}`);
  if (result === xmlWithInstances) {
    throw new Error('Unable to insert the component into the sketch instance list.');
  }
  return result;
}

function placePartInSketchXml(xml: string, options: { title: string; x: number; y: number; view?: string }): string {
  const title = escapeXml(options.title);
  const view = options.view || 'breadboardView';
  const instancePattern = new RegExp(`<instance\\b[^>]*>\\s*<title>${title.replace(/&/g, '&amp;')}<\\/title>\\s*.*?<\\/instance>`, 'is');
  const match = xml.match(instancePattern);
  if (!match) {
    throw new Error(`Part titled '${options.title}' was not found in the sketch.`);
  }

  const block = match[0];
  const updatedBlock = block.replace(/<geometry\b[^>]*\/>/i, `<geometry z="3.5" x="${options.x}" y="${options.y}"/>`);
  if (updatedBlock === block) {
    throw new Error(`Could not update the placement geometry for '${options.title}'.`);
  }

  return xml.replace(block, updatedBlock);
}

function wirePartsInSketchXml(xml: string, options: {
  from: string;
  to: string;
  title?: string;
  x1?: number;
  y1?: number;
  x2?: number;
  y2?: number;
}): string {
  const [fromPart, fromConnector = 'connector0'] = options.from.split(':');
  const [toPart, toConnector = 'connector0'] = options.to.split(':');
  const wireTitle = options.title || `Wire${Math.floor(Math.random() * 10000)}`;
  const x1 = options.x1 ?? 0;
  const y1 = options.y1 ?? 0;
  const x2 = options.x2 ?? 100;
  const y2 = options.y2 ?? 100;

  const block = `
        <instance moduleIdRef="WireModuleID" modelIndex="${Math.floor(Math.random() * 100000)}" path="wire.fzp">
            <title>${escapeXml(wireTitle)}</title>
            <views>
                <breadboardView layer="breadboardWire">
                    <geometry z="3.5" x="${x1}" y="${y1}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" wireFlags="64"/>
                </breadboardView>
            </views>
            <connectors>
                <connector connectorId="connector0" layer="breadboardWire">
                    <geometry x="0" y="0"/>
                    <connects>
                        <connect part="${escapeXml(fromPart)}" connectorId="${escapeXml(fromConnector)}"/>
                    </connects>
                </connector>
                <connector connectorId="connector1" layer="breadboardWire">
                    <geometry x="0" y="0"/>
                    <connects>
                        <connect part="${escapeXml(toPart)}" connectorId="${escapeXml(toConnector)}"/>
                    </connects>
                </connector>
            </connectors>
        </instance>`;

  return ensureInstancesElement(xml).replace(/<instances\s*>/i, `<instances>${block}`);
}

export function getProjectLiveFolder(projectPath: string): string {
  return join(dirname(projectPath), `.${basename(projectPath, normalizeSketchExtension(projectPath))}_live`);
}

async function isProjectOpenInFritzing(projectPath: string): Promise<boolean> {
  const projectFileName = basename(projectPath).toLowerCase();
  const instances = await listRunningFritzingInstances();
  return instances.some(instance => {
    const matchingWindow = instance.windowTitle.toLowerCase().startsWith(`${projectFileName} - fritzing`);
    const plainGuiLaunch = /^"[^"]*fritzing\.exe"\s*$/i.test(instance.commandLine);
    return matchingWindow || plainGuiLaunch;
  });
}

async function exportProjectSvg(projectPath: string): Promise<{ logPath: string; svgPath: string; exportDir: string }> {
  const exportDir = getProjectLiveFolder(projectPath);
  const currentSvgPath = join(exportDir, 'current.svg');
  const logPath = join(exportDir, 'log.txt');
  await mkdir(exportDir, { recursive: true });

  const writeLog = async (status: string, result?: { code: number | null; stdout: string; stderr: string }): Promise<void> => {
    const logText = [
      `Project: ${projectPath}`,
      `Generated: ${new Date().toISOString()}`,
      `Export folder: ${exportDir}`,
      `Current SVG: ${currentSvgPath}`,
      `Status: ${status}`,
      result ? `Fritzing exit code: ${result.code}` : '',
      result ? `Stdout: ${result.stdout.trim() || '(empty)'}` : '',
      result ? `Stderr: ${result.stderr.trim() || '(empty)'}` : ''
    ].filter(Boolean).join(EOL);
    await writeFile(logPath, logText, 'utf8');
  };

  await writeLog('Export started.');

  const existing = await readdir(exportDir).catch(() => []);
  for (const entry of existing) {
    const fullPath = join(exportDir, entry);
    if (entry.toLowerCase().endsWith('.svg') && entry.toLowerCase() !== 'current.svg') {
      await rm(fullPath, { recursive: true, force: true });
    }
  }

  const fritzingExecutable = process.env.FRITZING_EXECUTABLE ?? 'C:\\Program Files\\Fritzing\\Fritzing.exe';
  const appResourceFolder = resolve(repoRoot, 'resources');
  const result = await runProcess(fritzingExecutable, ['-f', appResourceFolder, '-svg', exportDir, projectPath], dirname(projectPath));
  if (result.code !== 0) {
    await writeLog('Export failed.', result);
    throw new Error(`Fritzing export failed for ${projectPath}. Exit code: ${result.code}${EOL}${result.stderr || result.stdout}`);
  }

  const svgFiles = (await readdir(exportDir)).filter(name => name.toLowerCase().endsWith('.svg') && name.toLowerCase() !== 'current.svg');
  if (svgFiles.length === 0) {
    await writeLog('Export failed: no SVG file was generated.', result);
    throw new Error(`No SVG file was generated for ${projectPath}`);
  }

  const svgMeta = await Promise.all(svgFiles.map(async (name) => {
    try {
      const fullPath = join(exportDir, name);
      const fileInfo = await stat(fullPath);
      return { name, fullPath, time: fileInfo.mtimeMs };
    } catch {
      return { name, fullPath: join(exportDir, name), time: 0 };
    }
  }));

  const newestSvg = svgMeta.sort((a, b) => b.time - a.time).at(0);

  if (!newestSvg) {
    await writeLog('Export failed: no SVG export could be selected.', result);
    throw new Error(`No SVG export could be selected for ${projectPath}`);
  }

  await copyFile(newestSvg.fullPath, currentSvgPath);
  await writeLog('Export completed.', result);

  return { logPath, svgPath: currentSvgPath, exportDir };
}

export async function snapshotProject(projectPath: string): Promise<string> {
  const { svgPath, logPath } = await exportProjectSvg(projectPath);
  console.log(`SVG snapshot updated: ${svgPath}`);
  console.log(`Log updated: ${logPath}`);
  return svgPath;
}

async function saveSketchAndSnapshot(sketchPath: string, xml: string): Promise<void> {
  const projectIsOpen = await isProjectOpenInFritzing(sketchPath);
  if (projectIsOpen) {
    await writeFile(`${sketchPath}.fritzing-cli-update`, new Date().toISOString(), 'utf8');
  }
  await writeSketchModel(sketchPath, xml, true);
  if (projectIsOpen) {
    console.log('Saved sketch. The open Fritzing window will reload it and refresh the live SVG and log.');
    return;
  }
  await snapshotProject(sketchPath);
}

export async function listPartsInSketch(sketchPath: string): Promise<Array<{ title: string; moduleIdRef: string; path: string; x: string; y: string }>> {
  const xml = await readSketchModel(sketchPath);
  const entries = [...xml.matchAll(/<instance\b([^>]*)>([\s\S]*?)<\/instance>/gi)];
  const parts = entries
    .map((match) => {
      const attrs = match[1] ?? '';
      const body = match[2] ?? '';
      const moduleIdRef = (attrs.match(/\bmoduleIdRef="([^"]+)"/i)?.[1] ?? '').trim();
      const path = (attrs.match(/\bpath="([^"]+)"/i)?.[1] ?? '').trim();
      const title = (body.match(/<title>([\s\S]*?)<\/title>/i)?.[1] ?? '').trim();
      const geometryMatch = body.match(/<geometry\b[^>]*\bx="([^"]+)"[^>]*\by="([^"]+)"/i);
      const x = geometryMatch?.[1] ?? '(unknown)';
      const y = geometryMatch?.[2] ?? '(unknown)';
      return { title, moduleIdRef, path, x, y };
    })
    .filter(part => part.title.length > 0 || part.moduleIdRef.length > 0 || part.path.length > 0)
    .filter(part => part.moduleIdRef !== 'WireModuleID');

  return parts;
}

function printCliUsage(): void {
  const lines = [
    'Fritzing CLI',
    '',
    'Usage:',
    '  node dist/index.js help',
    '  node dist/index.js list-sketches --folder sketches --limit 20',
    '  node dist/index.js inspect-sketch --path sketches/core/555TouchSwitch.fzz',
    '  node dist/index.js read-sketch-model --path sketches/core/555TouchSwitch.fzz',
    '  node dist/index.js find-parts --query 555 --limit 10',
    '  node dist/index.js list-parts --path sketches/core/555TouchSwitch.fzz',
    '  node dist/index.js running-instances',
    '  node dist/index.js update-parts-library',
    '  node dist/index.js add-part --path sketches/my-sketch.fzz --module-id resistor --title R1 --x 50 --y 20',
    '  node dist/index.js place-part --path sketches/my-sketch.fzz --title R1 --x 100 --y 80',
    '  node dist/index.js wire-parts --path sketches/my-sketch.fzz --from R1:connector0 --to LED1:connector0',
    '  node dist/index.js snapshot-project --path sketches/core/555TouchSwitch.fzz',
    '  node dist/index.js watch-project --path sketches/core/555TouchSwitch.fzz --delay 500',
    '  node dist/index.js serve --port 3000',
    '  node dist/index.js --mcp',
    '',
    'Options:',
    '  --folder <path>      Search folder relative to the workspace root or absolute.',
    '  --path <path>        Absolute or workspace-relative path to a sketch or file.',
    '  --query <text>       Search string for installed parts.',
    '  --limit <number>     Maximum items to return.',
    '  --module-id <id>     Module identifier to add.',
    '  --title <name>       Part or wire name to add or move.',
    '  --x <value>          X coordinate for placement.',
    '  --y <value>          Y coordinate for placement.',
    '  --from <ref>         Source connector reference like "R1:connector0".',
    '  --to <ref>           Destination connector reference like "LED1:connector1".',
    '  --delay <ms>         Milliseconds to wait before re-exporting after a change event.',
    '  --port <number>      HTTP port for the UI server (default 3000).',
    '  --overwrite          Allow replacing an existing file or destination path.',
    '  --recursive          Delete folders recursively.',
    '  --mcp                Start the stdio MCP server instead of CLI mode.',
    '',
    'Commands:',
    '  running-instances    List active Windows Fritzing processes with PID, executable, and launch command.'
  ];
  console.log(lines.join(EOL));
}

async function runCli(argv: string[]): Promise<number> {
  const args = argv.slice(2);
  if (args.length === 0 || args.includes('--help') || args.includes('help')) {
    printCliUsage();
    return 0;
  }

  if (args.includes('--mcp') || args[0] === 'mcp') {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    return 0;
  }

  const command = args[0];
  const options = new Map<string, string>();
  for (let i = 1; i < args.length; i += 1) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const next = args[i + 1];
      if (next && !next.startsWith('--')) {
        options.set(arg, next);
        i += 1;
      } else {
        options.set(arg, 'true');
      }
    }
  }

  switch (command) {
    case 'list-sketches': {
      const folder = options.get('--folder') ?? 'sketches';
      const limit = Number(options.get('--limit') ?? '50');
      const sketches = await findSketches(resolveWorkspacePath(folder), limit);
      console.log(sketches.length > 0 ? sketches.join(EOL) : `No .fz or .fzz sketches found under ${folder}`);
      return 0;
    }
    case 'inspect-sketch': {
      const sketchPath = options.get('--path');
      if (!sketchPath) {
        throw new Error('inspect-sketch requires --path <sketchPath>.');
      }
      console.log(await readSketchSummary(resolveWorkspacePath(sketchPath)));
      return 0;
    }
    case 'read-sketch-model': {
      const sketchPath = options.get('--path');
      if (!sketchPath) {
        throw new Error('read-sketch-model requires --path <sketchPath>.');
      }
      console.log(await readSketchModel(resolveWorkspacePath(sketchPath)));
      return 0;
    }
    case 'find-parts': {
      const query = options.get('--query');
      if (!query) {
        throw new Error('find-parts requires --query <text>.');
      }
      const limit = Number(options.get('--limit') ?? '10');
      const parts = await findParts(query, limit);
      if (parts.length === 0) {
        console.log(`No installed Fritzing parts matched '${query}'.`);
        return 0;
      }
      console.log(parts.map(part => `${part.title}${EOL}moduleId: ${part.moduleId}${EOL}path: ${part.path}`).join(`${EOL}${EOL}`));
      return 0;
    }
    case 'update-parts-library': {
      const partsRoot = getPartsRoot();
      if (!await exists(partsRoot)) {
        throw new Error(`Configured Fritzing parts repository does not exist: ${partsRoot}`);
      }
      const result = await runProcess('git', ['pull', '--ff-only'], partsRoot);
      console.log([
        `Parts repository: ${partsRoot}`,
        `Exit code: ${result.code}`,
        result.stdout.trim(),
        result.stderr.trim()
      ].filter(Boolean).join(EOL));
      return result.code === 0 ? 0 : 1;
    }
    case 'add-part': {
      const sketchPath = options.get('--path');
      const moduleId = options.get('--module-id');
      const title = options.get('--title') ?? 'Part';
      const x = Number(options.get('--x') ?? '0');
      const y = Number(options.get('--y') ?? '0');
      if (!sketchPath || !moduleId) {
        throw new Error('add-part requires --path <sketchPath> and --module-id <moduleId>.');
      }
      const resolvedPath = resolveWorkspacePath(sketchPath);
      const xml = await readSketchModel(resolvedPath);
      const updatedXml = addPartToSketchXml(xml, { moduleIdRef: moduleId, title, x, y, path: `${moduleId}.fzp` });
      await saveSketchAndSnapshot(resolvedPath, updatedXml);
      console.log(`Added part '${title}' to ${resolvedPath}`);
      return 0;
    }
    case 'place-part': {
      const sketchPath = options.get('--path');
      const title = options.get('--title');
      const x = Number(options.get('--x') ?? '0');
      const y = Number(options.get('--y') ?? '0');
      if (!sketchPath || !title) {
        throw new Error('place-part requires --path <sketchPath> and --title <partTitle>.');
      }
      const resolvedPath = resolveWorkspacePath(sketchPath);
      const xml = await readSketchModel(resolvedPath);
      const updatedXml = placePartInSketchXml(xml, { title, x, y });
      await saveSketchAndSnapshot(resolvedPath, updatedXml);
      console.log(`Placed part '${title}' at (${x}, ${y}) in ${resolvedPath}`);
      return 0;
    }
    case 'wire-parts': {
      const sketchPath = options.get('--path');
      const from = options.get('--from');
      const to = options.get('--to');
      const x1 = Number(options.get('--x1') ?? '0');
      const y1 = Number(options.get('--y1') ?? '0');
      const x2 = Number(options.get('--x2') ?? '100');
      const y2 = Number(options.get('--y2') ?? '100');
      if (!sketchPath || !from || !to) {
        throw new Error('wire-parts requires --path <sketchPath>, --from <part:connector>, and --to <part:connector>.');
      }
      const resolvedPath = resolveWorkspacePath(sketchPath);
      const xml = await readSketchModel(resolvedPath);
      const updatedXml = wirePartsInSketchXml(xml, { from, to, x1, y1, x2, y2 });
      await saveSketchAndSnapshot(resolvedPath, updatedXml);
      console.log(`Wired ${from} to ${to} in ${resolvedPath}`);
      return 0;
    }
    case 'list-parts': {
      const sketchPath = options.get('--path');
      if (!sketchPath) {
        throw new Error('list-parts requires --path <sketchPath>.');
      }
      const resolvedPath = resolveWorkspacePath(sketchPath);
      const parts = await listPartsInSketch(resolvedPath);
      if (parts.length === 0) {
        console.log(`No part instances found in ${resolvedPath}`);
        return 0;
      }
      console.log(parts.map(part => `${part.title || '(untitled)'}${EOL}moduleIdRef: ${part.moduleIdRef || '(none)'}${EOL}path: ${part.path || '(none)'}${EOL}position: (${part.x}, ${part.y})`).join(`${EOL}${EOL}`));
      return 0;
    }
    case 'running-instances': {
      const instances = await listRunningFritzingInstances();
      if (instances.length === 0) {
        console.log('No running Fritzing instances found.');
        return 0;
      }
      console.log(instances.map(instance => [
        `PID: ${instance.processId}`,
        `Executable: ${instance.executablePath}`,
        `Window: ${instance.windowTitle || '(no window)'}`,
        `Command line: ${instance.commandLine}`
      ].join(EOL)).join(`${EOL}${EOL}`));
      return 0;
    }
    case 'snapshot-project': {
      const sketchPath = options.get('--path');
      if (!sketchPath) {
        throw new Error('snapshot-project requires --path <sketchPath>.');
      }
      const resolvedPath = resolveWorkspacePath(sketchPath);
      await snapshotProject(resolvedPath);
      return 0;
    }
    case 'watch-project': {
      const sketchPath = options.get('--path');
      if (!sketchPath) {
        throw new Error('watch-project requires --path <sketchPath>.');
      }

      const resolvedPath = resolveWorkspacePath(sketchPath);
      const delayMs = Number(options.get('--delay') ?? '500');
      const parentFolder = dirname(resolvedPath);
      const exportDir = getProjectLiveFolder(resolvedPath);
      await mkdir(exportDir, { recursive: true });

      const render = async () => {
        const svgPath = await snapshotProject(resolvedPath);
        return svgPath;
      };

      await render();
      console.log(`Watching ${resolvedPath} for changes. Export directory: ${exportDir}`);

      let timeout: NodeJS.Timeout | undefined;
      const triggerRender = () => {
        if (timeout) {
          clearTimeout(timeout);
        }
        timeout = setTimeout(() => {
          render().catch((error: unknown) => {
            console.error(`Watch render failed: ${error instanceof Error ? error.message : String(error)}`);
          });
        }, delayMs);
      };

      const fileWatcher = watch(resolvedPath, { persistent: true }, () => triggerRender());
      const directoryWatcher = watch(parentFolder, { persistent: true }, (_eventType, filename) => {
        if (!filename) {
          return;
        }
        const matchPath = join(parentFolder, filename.toString());
        if (matchPath.toLowerCase() === resolvedPath.toLowerCase()) {
          triggerRender();
        }
      });

      const handleExit = () => {
        fileWatcher.close();
        directoryWatcher.close();
        process.exit(0);
      };

      process.on('SIGINT', handleExit);
      process.on('SIGTERM', handleExit);
      return 0;
    }
    case 'serve': {
      const port = Number(options.get('--port') ?? '3000');
      await startHttpServer(port);
      console.log(`Fritzing CLI server listening on http://127.0.0.1:${port}`);
      return 0;
    }
    default:
      printCliUsage();
      throw new Error(`Unknown CLI command: ${command}`);
  }
}

export async function main(): Promise<void> {
  const argv = process.argv;
  if (argv.includes('--mcp') || argv.includes('mcp')) {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    return;
  }

  const exitCode = await runCli(argv);
  process.exitCode = exitCode;
}

