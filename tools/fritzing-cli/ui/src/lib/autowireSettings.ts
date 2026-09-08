import { fetchJson } from './api'

export type AutowireSettings = {
  placeParts: boolean
  resetRotations: boolean
  railJumpers: boolean
  wireSignals: boolean
  cleanOnly: boolean
  boardGap: number
  partSpacing: number
}

export const defaultAutowireSettings: AutowireSettings = {
  placeParts: true,
  resetRotations: true,
  railJumpers: true,
  wireSignals: true,
  cleanOnly: false,
  boardGap: 60,
  partSpacing: 45,
}

// The server owns the settings; the UI just reads and writes them.
export function loadAutowireSettings(): Promise<AutowireSettings> {
  return fetchJson<AutowireSettings>('/api/settings/autowire')
}

export function saveAutowireSettings(settings: AutowireSettings): Promise<AutowireSettings> {
  return fetchJson<AutowireSettings>('/api/settings/autowire', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(settings),
  })
}
