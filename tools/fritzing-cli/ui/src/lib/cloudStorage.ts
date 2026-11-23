// Client for the Cloudflare (Worker + R2) storage API.
// Every call needs a Firebase ID token; the Worker verifies it and scopes files to the user's uid.

const baseUrl = import.meta.env.VITE_STORAGE_API_URL as string | undefined

export class StorageUnavailableError extends Error {}

async function request(token: string | null, path: string, init: RequestInit = {}) {
  if (!token) throw new StorageUnavailableError('Sign in to use cloud storage.')
  if (!baseUrl) throw new StorageUnavailableError('Cloud storage is not configured (VITE_STORAGE_API_URL).')
  const res = await fetch(`${baseUrl.replace(/\/$/, '')}${path}`, {
    ...init,
    headers: { ...init.headers, Authorization: `Bearer ${token}` },
  })
  if (!res.ok) throw new Error(`Storage request failed: ${res.status} ${await res.text()}`)
  return res
}

export async function listFiles(token: string | null): Promise<{ key: string; size: number; uploaded: string }[]> {
  return (await request(token, '/files')).json()
}

export async function uploadFile(token: string | null, name: string, body: Blob | string): Promise<void> {
  await request(token, `/files/${encodeURIComponent(name)}`, { method: 'PUT', body })
}

export async function downloadFile(token: string | null, name: string): Promise<Blob> {
  return (await request(token, `/files/${encodeURIComponent(name)}`)).blob()
}

export async function deleteFile(token: string | null, name: string): Promise<void> {
  await request(token, `/files/${encodeURIComponent(name)}`, { method: 'DELETE' })
}

// ---- Official parts library (public, no sign-in) ----

/** True when VITE_PARTS_SOURCE=cloud: part search and images come from the Worker instead of the local server. */
export const cloudPartsDefault = import.meta.env.VITE_PARTS_SOURCE === 'cloud' && Boolean(baseUrl)
export const cloudPartsAvailable = Boolean(baseUrl)

const workerUrl = (path: string) => `${(baseUrl ?? '').replace(/\/$/, '')}${path}`

export async function searchCloudParts(query: string, limit = 25): Promise<{ moduleId: string; title: string; path: string }[]> {
  if (!baseUrl) throw new StorageUnavailableError('Cloud parts are not configured (VITE_STORAGE_API_URL).')
  const res = await fetch(workerUrl(`/parts?q=${encodeURIComponent(query)}&limit=${limit}`))
  if (!res.ok) throw new Error(`Cloud part search failed: ${res.status} ${await res.text()}`)
  return (await res.json()).parts
}

export function cloudPartImageUrl(ref: { moduleId?: string; path?: string }, view: 'breadboard' | 'schematic' = 'breadboard'): string {
  const params = new URLSearchParams({ view })
  if (ref.path) params.set('path', ref.path)
  else if (ref.moduleId) params.set('moduleId', ref.moduleId)
  return workerUrl(`/parts/image?${params}`)
}

// ---- The signed-in user's own parts: ordinary files under parts/ ----

const USER_PARTS = 'parts/'

export async function listUserParts(token: string | null) {
  return (await listFiles(token))
    .filter((f) => f.key.startsWith(USER_PARTS))
    .map((f) => ({ ...f, name: f.key.slice(USER_PARTS.length) }))
}

export const uploadUserPart = (token: string | null, file: File) => uploadFile(token, USER_PARTS + file.name, file)
export const downloadUserPart = (token: string | null, name: string) => downloadFile(token, USER_PARTS + name)
export const deleteUserPart = (token: string | null, name: string) => deleteFile(token, USER_PARTS + name)
