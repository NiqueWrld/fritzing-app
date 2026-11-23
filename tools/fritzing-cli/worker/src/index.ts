// Fritzing cloud storage: Cloudflare Worker + R2.
// Every request must carry a Firebase ID token; files are stored under users/<uid>/.
//
//   GET    /files          -> [{ key, size, uploaded }]
//   GET    /files/:name    -> file body
//   PUT    /files/:name    -> store body
//   DELETE /files/:name
//   (user parts are ordinary files under parts/, e.g. PUT /files/parts/my-sensor.fzpz)
//
// Public, read-only official parts library (no sign-in), stored under library/:
//   GET    /parts?q=555&limit=25          -> { parts: [{ moduleId, title, path }] }
//   GET    /parts/image?moduleId=..&view=breadboard|schematic
//   GET    /parts/file/<path>            -> raw .fzp / .svg
//   PUT    /parts/file/<path>            -> upload (needs Bearer PARTS_UPLOAD_TOKEN)
//   GET    /parts/file/bundle/version.txt    -> parts commit the desktop/Android app should have
//   GET    /parts/file/bundle/fritzing-parts.zip -> whole library, downloaded by the app on launch

import { createRemoteJWKSet, jwtVerify } from 'jose'

export interface Env {
  BUCKET: R2Bucket
  FIREBASE_PROJECT_ID: string
  ALLOWED_ORIGINS: string
  MAX_FILE_BYTES?: string
  // Secret (wrangler secret put PARTS_UPLOAD_TOKEN) for the library upload script.
  PARTS_UPLOAD_TOKEN?: string
}

const LIBRARY = 'library/'
const INDEX_KEY = `${LIBRARY}index.json`
const PUBLIC_CACHE = 'public, max-age=3600'

type IndexedPart = { moduleId: string; title: string; path: string; breadboard?: string; schematic?: string }

// Cached per isolate; refreshed when the index object's etag changes.
let libraryIndex: { etag: string; parts: IndexedPart[]; byId: Map<string, IndexedPart> } | undefined

async function loadIndex(env: Env) {
  const head = await env.BUCKET.head(INDEX_KEY)
  if (!head) return undefined
  if (libraryIndex?.etag === head.etag) return libraryIndex
  const obj = await env.BUCKET.get(INDEX_KEY)
  if (!obj) return undefined
  const parts = (await obj.json()) as IndexedPart[]
  libraryIndex = { etag: obj.etag, parts, byId: new Map(parts.map((p) => [p.moduleId, p])) }
  return libraryIndex
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

async function serveObject(env: Env, key: string, cache: string): Promise<Response> {
  const obj = await env.BUCKET.get(key)
  if (!obj) return new Response('Not found', { status: 404 })
  const headers = new Headers()
  obj.writeHttpMetadata(headers)
  headers.set('ETag', obj.httpEtag)
  headers.set('Cache-Control', cache)
  return new Response(obj.body, { headers })
}

async function handleParts(request: Request, env: Env, url: URL): Promise<Response> {
  if (url.pathname.startsWith('/parts/file/')) {
    const name = safeName(url.pathname.slice('/parts/file/'.length))
    if (!name) return new Response('Bad file name', { status: 400 })
    if (request.method === 'GET') return serveObject(env, LIBRARY + name, PUBLIC_CACHE)
    if (request.method !== 'PUT') return new Response('Method not allowed', { status: 405 })
    const token = request.headers.get('Authorization')?.match(/^Bearer (.+)$/)?.[1]
    if (!env.PARTS_UPLOAD_TOKEN || !token || !constantTimeEqual(token, env.PARTS_UPLOAD_TOKEN)) {
      return new Response('Unauthorized', { status: 401 })
    }
    // Stream the body: the app's parts bundle (bundle/fritzing-parts.zip) is ~40 MB.
    if (!request.body || !request.headers.get('Content-Length')) return new Response('Content-Length required', { status: 411 })
    await env.BUCKET.put(LIBRARY + name, request.body, {
      httpMetadata: { contentType: request.headers.get('Content-Type') ?? 'application/octet-stream' },
    })
    return new Response(null, { status: 204 })
  }
  if (request.method !== 'GET') return new Response('Method not allowed', { status: 405 })

  const index = await loadIndex(env)
  if (!index) return Response.json({ error: 'Parts library has not been uploaded yet.' }, { status: 503 })

  if (url.pathname === '/parts') {
    const q = (url.searchParams.get('q') ?? '').trim().toLowerCase()
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 25) || 25, 1), 200)
    const parts = q
      ? index.parts
          .filter((p) => `${p.path} ${p.moduleId} ${p.title}`.toLowerCase().includes(q))
          .slice(0, limit)
          .map(({ moduleId, title, path }) => ({ moduleId, title, path }))
      : []
    return Response.json({ parts }, { headers: { 'Cache-Control': 'public, max-age=300' } })
  }

  if (url.pathname === '/parts/image') {
    const moduleId = url.searchParams.get('moduleId') ?? ''
    const path = url.searchParams.get('path')
    const part = path ? index.parts.find((p) => p.path === path) : index.byId.get(moduleId)
    if (!part) return new Response('Part not found', { status: 404 })
    const image = url.searchParams.get('view') === 'schematic' ? part.schematic : part.breadboard
    if (!image) return new Response('Part has no image for that view', { status: 404 })
    return serveObject(env, LIBRARY + image, PUBLIC_CACHE)
  }

  return new Response('Not found', { status: 404 })
}

// Google's public keys for Firebase ID tokens (cached by jose across requests in the same isolate).
const JWKS = createRemoteJWKSet(
  new URL('https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com'),
)

async function verifyUid(request: Request, env: Env): Promise<string | null> {
  const match = request.headers.get('Authorization')?.match(/^Bearer (.+)$/)
  if (!match) return null
  try {
    const { payload } = await jwtVerify(match[1], JWKS, {
      issuer: `https://securetoken.google.com/${env.FIREBASE_PROJECT_ID}`,
      audience: env.FIREBASE_PROJECT_ID,
      algorithms: ['RS256'],
    })
    return typeof payload.sub === 'string' && payload.sub ? payload.sub : null
  } catch {
    return null
  }
}

function corsHeaders(request: Request, env: Env): Record<string, string> {
  const origin = request.headers.get('Origin') ?? ''
  const allowed = env.ALLOWED_ORIGINS.split(',').map((o) => o.trim())
  if (!allowed.includes(origin)) return {}
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  }
}

// Allow plain names and sub-folders; reject anything that could escape the user's prefix.
function safeName(raw: string): string | null {
  let name: string
  try {
    name = decodeURIComponent(raw)
  } catch {
    return null
  }
  if (!name || name.length > 512 || name.startsWith('/') || name.includes('\\')) return null
  if (name.split('/').some((part) => part === '' || part === '.' || part === '..')) return null
  return name
}

async function handle(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url)
  if (url.pathname === '/parts' || url.pathname.startsWith('/parts/')) return handleParts(request, env, url)
  if (url.pathname !== '/files' && !url.pathname.startsWith('/files/')) {
    return new Response('Not found', { status: 404 })
  }

  const uid = await verifyUid(request, env)
  if (!uid) return new Response('Unauthorized', { status: 401 })
  const prefix = `users/${uid}/`

  if (url.pathname === '/files') {
    if (request.method !== 'GET') return new Response('Method not allowed', { status: 405 })
    const files: { key: string; size: number; uploaded: string }[] = []
    let cursor: string | undefined
    do {
      const page = await env.BUCKET.list({ prefix, cursor })
      for (const o of page.objects) {
        files.push({ key: o.key.slice(prefix.length), size: o.size, uploaded: o.uploaded.toISOString() })
      }
      cursor = page.truncated ? page.cursor : undefined
    } while (cursor)
    return Response.json(files)
  }

  const name = safeName(url.pathname.slice('/files/'.length))
  if (!name) return new Response('Bad file name', { status: 400 })
  const key = prefix + name

  switch (request.method) {
    case 'GET': {
      const obj = await env.BUCKET.get(key)
      if (!obj) return new Response('Not found', { status: 404 })
      const headers = new Headers()
      obj.writeHttpMetadata(headers)
      headers.set('ETag', obj.httpEtag)
      return new Response(obj.body, { headers })
    }
    case 'PUT': {
      const max = Number(env.MAX_FILE_BYTES ?? 26214400)
      const declared = Number(request.headers.get('Content-Length') ?? NaN)
      if (Number.isFinite(declared) && declared > max) return new Response('File too large', { status: 413 })
      const body = await request.arrayBuffer()
      if (body.byteLength > max) return new Response('File too large', { status: 413 })
      await env.BUCKET.put(key, body, {
        httpMetadata: { contentType: request.headers.get('Content-Type') ?? 'application/octet-stream' },
      })
      return new Response(null, { status: 204 })
    }
    case 'DELETE':
      await env.BUCKET.delete(key)
      return new Response(null, { status: 204 })
    default:
      return new Response('Method not allowed', { status: 405 })
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const cors = corsHeaders(request, env)
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors })
    let res: Response
    try {
      res = await handle(request, env)
    } catch (e) {
      console.error(e)
      res = new Response('Internal error', { status: 500 })
    }
    const out = new Response(res.body, res)
    for (const [k, v] of Object.entries(cors)) out.headers.set(k, v)
    return out
  },
} satisfies ExportedHandler<Env>
