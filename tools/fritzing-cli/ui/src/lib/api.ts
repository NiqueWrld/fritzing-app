export type Part = { moduleId: string; title: string; path: string }

export async function fetchJson<T>(input: string, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init)
  const body = await response.json()
  if (!response.ok) {
    throw new Error(body.error ?? `Request failed: ${response.status}`)
  }
  return body as T
}
