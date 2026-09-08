import { useEffect, useState } from 'react'
import { useTheme } from '../context/ThemeContext'
import {
  defaultAutowireSettings,
  loadAutowireSettings,
  saveAutowireSettings,
  type AutowireSettings,
} from '../lib/autowireSettings'

export default function Settings() {
  const { theme } = useTheme()
  const [settings, setSettings] = useState<AutowireSettings>(defaultAutowireSettings)
  const [error, setError] = useState<string>()

  useEffect(() => {
    loadAutowireSettings()
      .then(loaded => {
        setSettings(loaded)
        setError(undefined)
      })
      .catch((requestError: Error) => setError(`Could not load settings from the server: ${requestError.message}`))
  }, [])

  const update = (patch: Partial<AutowireSettings>) => {
    const next = { ...settings, ...patch }
    setSettings(next)
    saveAutowireSettings(next)
      .then(saved => {
        setSettings(saved)
        setError(undefined)
      })
      .catch((requestError: Error) => setError(`Could not save settings: ${requestError.message}`))
  }

  const toggles: Array<{ key: keyof AutowireSettings; label: string; description: string }> = [
    { key: 'cleanOnly', label: 'Clean only', description: 'Keep the existing connections — just tidy the layout and re-route the wires. No new connections are made.' },
    { key: 'placeParts', label: 'Arrange parts', description: 'Move the MCU below the breadboard and line sensors up above it.' },
    { key: 'resetRotations', label: 'Reset rotations', description: 'Restore natural orientation so pins face the breadboard.' },
    { key: 'railJumpers', label: 'Rail jumpers', description: 'Bridge the top and bottom power rail pairs. Skipped in clean-only mode.' },
    { key: 'wireSignals', label: 'Wire signal pins', description: 'Connect sensor signal pins to free Arduino pins. Skipped in clean-only mode.' },
  ]

  const numbers: Array<{ key: 'boardGap' | 'partSpacing'; label: string; description: string }> = [
    { key: 'boardGap', label: 'Board gap', description: 'Distance between parts and the breadboard (scene units).' },
    { key: 'partSpacing', label: 'Part spacing', description: 'Extra space between sensors in the row.' },
  ]

  return (
    <section className="max-w-xl">
      <h2 className="mb-3 text-lg font-medium">Auto wire settings</h2>
      <p className={`mb-6 text-sm ${theme.tint.faint}`}>Stored on the fritzing-cli server and applied on every Auto wire run.</p>

      {error && (
        <div className={`mb-4 rounded-lg border px-4 py-3 text-sm ${theme.tint.warning}`}>{error}</div>
      )}

      <ul className="space-y-3">
        {toggles.map(({ key, label, description }) => (
          <li key={key} className={`flex items-center justify-between gap-4 rounded-xl border ${theme.secondary.borderSoft} ${theme.secondary.surface} p-4`}>
            <div>
              <p className="font-medium">{label}</p>
              <p className={`mt-1 text-xs ${theme.tint.muted}`}>{description}</p>
            </div>
            <input
              type="checkbox"
              checked={Boolean(settings[key])}
              onChange={event => update({ [key]: event.target.checked })}
              className="h-5 w-5 accent-sky-600"
            />
          </li>
        ))}
        {numbers.map(({ key, label, description }) => (
          <li key={key} className={`flex items-center justify-between gap-4 rounded-xl border ${theme.secondary.borderSoft} ${theme.secondary.surface} p-4`}>
            <div>
              <p className="font-medium">{label}</p>
              <p className={`mt-1 text-xs ${theme.tint.muted}`}>{description}</p>
            </div>
            <input
              type="number"
              min={10}
              max={300}
              value={settings[key]}
              onChange={event => update({ [key]: Number(event.target.value) || defaultAutowireSettings[key] })}
              className={`w-24 rounded-lg border ${theme.secondary.input} px-3 py-2 text-sm outline-none ${theme.primary.focusBorder}`}
            />
          </li>
        ))}
      </ul>

      <button
        type="button"
        onClick={() => update(defaultAutowireSettings)}
        className={`mt-6 rounded-lg border ${theme.secondary.border} px-3 py-2 text-sm transition ${theme.primary.hoverBorder}`}
      >
        Reset to defaults
      </button>
    </section>
  )
}
