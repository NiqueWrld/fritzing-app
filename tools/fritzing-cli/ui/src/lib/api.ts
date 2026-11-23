import { cloudPartImageUrl, cloudPartsDefault } from './cloudStorage'

export type Part = { moduleId: string; title: string; path: string }

export async function fetchJson<T>(input: string, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init)
  const body = await response.json()
  if (!response.ok) {
    throw new Error(body.error ?? `Request failed: ${response.status}`)
  }
  return body as T
}

/** Part image URL from the local server, or from Cloudflare when VITE_PARTS_SOURCE=cloud. */
export function partImageUrl(moduleId: string, view: 'breadboard' | 'schematic' = 'breadboard'): string {
  if (cloudPartsDefault) return cloudPartImageUrl({ moduleId }, view)
  return `/api/part/image?moduleId=${encodeURIComponent(moduleId)}${view === 'schematic' ? '&view=schematic' : ''}`
}
