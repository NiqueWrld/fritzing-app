// Also publishes bundle/fritzing-parts.zip + bundle/version.txt (the parts commit), which the
// Fritzing desktop/Android app downloads on launch instead of shipping parts in the package.
// Pass --skip-files to publish only the bundle, --skip-bundle to skip it.
//
// Uploads the official Fritzing parts library to the Worker's R2 "library/" prefix and
// writes library/index.json (moduleId, title, fzp path, breadboard/schematic image paths).
//
//   $env:PARTS_UPLOAD_TOKEN = "<same value as the Worker secret>"
//   node scripts/upload-parts.mjs [--worker https://...workers.dev] [--root <fritzing-parts>] [--root <resources/parts>] [--dry-run]
//
// Defaults: roots = ../../../../fritzing-parts and ../../../resources/parts (relative to this
// script's repo); worker = https://fritzing-storage.siyathokoza321.workers.dev.

import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '../../../..')

const args = process.argv.slice(2)
const opt = (name) => {
  const values = []
  args.forEach((a, i) => a === name && args[i + 1] && values.push(args[i + 1]))
  return values
}
const dryRun = args.includes('--dry-run')
const skipFiles = args.includes('--skip-files')
const skipBundle = args.includes('--skip-bundle')
const worker = (opt('--worker')[0] ?? 'https://fritzing-storage.siyathokoza321.workers.dev').replace(/\/$/, '')
const roots = opt('--root').length
  ? opt('--root').map((r) => resolve(r))
  : [process.env.FRITZING_PARTS_PATH ?? resolve(repoRoot, '../fritzing-parts'), resolve(repoRoot, 'resources/parts')]
const token = process.env.PARTS_UPLOAD_TOKEN
if (!dryRun && !token) {
  console.error('Set PARTS_UPLOAD_TOKEN (same value as `wrangler secret put PARTS_UPLOAD_TOKEN`).')
  process.exit(1)
}

const contentTypes = { '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.fzp': 'application/xml' }
const toKey = (rootLabel, file, root) => `${rootLabel}/${relative(root, file).split(sep).join('/')}`

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) yield* walk(full)
    else if (entry.isFile()) yield full
  }
}

const uploads = new Map() // key -> local path
const index = []
const seen = new Set()

for (const [i, root] of roots.entries()) {
  if (!existsSync(root)) {
    console.warn(`Skipping missing parts root: ${root}`)
    continue
  }
  const label = i === 0 && basename(root) === 'fritzing-parts' ? 'fritzing-parts' : basename(root) === 'parts' ? `${basename(dirname(root))}-parts` : basename(root)
  for await (const file of walk(root)) {
    if (extname(file).toLowerCase() !== '.fzp') continue
    if (relative(root, file).split(sep)[0].toLowerCase() === 'svg') continue
    const xml = await readFile(file, 'utf8')
    const moduleId = xml.match(/<module\b[^>]*\bmoduleId="([^"]+)"/i)?.[1] ?? ''
    if (!moduleId || seen.has(moduleId)) continue
    seen.add(moduleId)
    const title = xml.match(/<title>([^<]+)<\/title>/i)?.[1] ?? basename(file)
    const family = basename(dirname(file))

    // Same lookup as the local server's /api/part/image.
    const resolveImage = (viewTag) => {
      const image = xml.match(new RegExp(`<${viewTag}\\b[^>]*>[\\s\\S]*?<layers[^>]*\\bimage="([^"]+)"`, 'i'))?.[1]
      if (!image || !contentTypes[extname(image).toLowerCase()]) return undefined
      for (const candidate of [join(dirname(file), image), join(root, 'svg', family, image), join(root, 'svg', 'core', image)]) {
        if (existsSync(candidate)) {
          const key = toKey(label, candidate, root)
          uploads.set(key, candidate)
          return key
        }
      }
      return undefined
    }

    const path = toKey(label, file, root)
    uploads.set(path, file)
    index.push({ moduleId, title, path, breadboard: resolveImage('breadboardView'), schematic: resolveImage('schematicView') })
  }
}

console.log(`${index.length} parts, ${uploads.size} files from ${roots.join(', ')}`)
if (dryRun) process.exit(0)

async function put(key, body, contentType) {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(`${worker}/parts/file/${key.split('/').map(encodeURIComponent).join('/')}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': contentType },
      body,
    })
    if (res.ok) return
    if (res.status === 401 || attempt >= 4) throw new Error(`PUT ${key}: ${res.status} ${await res.text()}`)
    await new Promise((r) => setTimeout(r, 500 * attempt))
  }
}

const queue = skipFiles ? [] : [...uploads]
let done = 0
await Promise.all(
  Array.from({ length: 16 }, async () => {
    while (queue.length) {
      const [key, file] = queue.pop()
      await put(key, await readFile(file), contentTypes[extname(file).toLowerCase()] ?? 'application/octet-stream')
      if (++done % 250 === 0) console.log(`${done}/${uploads.size}`)
    }
  }),
)

// Index last, so search never points at files that are not uploaded yet.
if (!skipFiles) {
  await put('index.json', JSON.stringify(index), 'application/json')
  console.log(`Uploaded ${done} files and index.json to ${worker}`)
}

if (!skipBundle) {
  const partsRepo = roots[0]
  if (!existsSync(join(partsRepo, '.git'))) throw new Error(`${partsRepo} must be a git checkout of fritzing-parts to publish the app bundle`)
  const sha = execFileSync('git', ['-C', partsRepo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  const tmp = await mkdtemp(join(tmpdir(), 'fritzing-parts-'))
  const zip = join(tmp, 'fritzing-parts.zip')
  // The app has no .git, so PartsChecker::getSha() reads the commit from .parts-sha.
  const shaFile = join(partsRepo, '.parts-sha')
  await writeFile(shaFile, sha)
  try {
    // Windows' bsdtar writes zip archives (Git Bash's GNU tar cannot).
    const tar = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\Windows', 'System32', 'tar.exe') : 'bsdtar'
    execFileSync(tar, ['-a', '-cf', zip, '--exclude=.git', '--exclude=.github', '.'], { cwd: partsRepo, stdio: 'inherit' })
  } finally {
    await rm(shaFile, { force: true })
  }
  const body = await readFile(zip)
  console.log(`Uploading app bundle (${(body.length / 1048576).toFixed(1)} MB, parts ${sha.slice(0, 10)})...`)
  await put('bundle/fritzing-parts.zip', body, 'application/zip')
  // Version last: the app only switches once the matching zip is in place.
  await put('bundle/version.txt', sha, 'text/plain')
  await rm(tmp, { recursive: true, force: true })
  console.log('Published bundle/fritzing-parts.zip and bundle/version.txt')
}
