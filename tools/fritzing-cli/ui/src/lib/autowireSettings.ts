export type AutowireSettings = {
  placeParts: boolean
  resetRotations: boolean
  railJumpers: boolean
  wireSignals: boolean
  boardGap: number
  partSpacing: number
}

export const defaultAutowireSettings: AutowireSettings = {
  placeParts: true,
  resetRotations: true,
  railJumpers: true,
  wireSignals: true,
  boardGap: 60,
  partSpacing: 45,
}

const storageKey = 'fritzing.autowire.settings'

export function loadAutowireSettings(): AutowireSettings {
  try {
    const raw = localStorage.getItem(storageKey)
    if (!raw) return defaultAutowireSettings
    return { ...defaultAutowireSettings, ...(JSON.parse(raw) as Partial<AutowireSettings>) }
  } catch {
    return defaultAutowireSettings
  }
}

export function saveAutowireSettings(settings: AutowireSettings): void {
  localStorage.setItem(storageKey, JSON.stringify(settings))
}

export function autowireQueryParams(settings: AutowireSettings): string {
  const params = new URLSearchParams({
    place: settings.placeParts ? '1' : '0',
    resetRotation: settings.resetRotations ? '1' : '0',
    jumpers: settings.railJumpers ? '1' : '0',
    signals: settings.wireSignals ? '1' : '0',
    gap: String(settings.boardGap),
    spacing: String(settings.partSpacing),
  })
  return params.toString()
}
