import { CircuitryIcon, CpuIcon, FileCodeIcon, GearIcon, PlugsConnectedIcon, PuzzlePieceIcon } from '@phosphor-icons/react'
import { NavLink } from 'react-router-dom'
import { useSketch } from '../../context/SketchContext'
import { useTheme } from '../../context/ThemeContext'

const links = [
  { to: '/', end: true, icon: FileCodeIcon, label: 'Sketches' },
  { to: '/parts', end: false, icon: PuzzlePieceIcon, label: 'Parts' },
  { to: '/breadboard', end: false, icon: CpuIcon, label: 'Breadboard' },
  { to: '/connections', end: false, icon: PlugsConnectedIcon, label: 'Connections' },
  { to: '/settings', end: false, icon: GearIcon, label: 'Settings' },
]

export default function Sidebar() {
  const { currentSketch } = useSketch()
  const { theme } = useTheme()
  const sketchName = currentSketch?.split(/[\\/]/).pop()
  const navLinkClass = ({ isActive }: { isActive: boolean }) =>
    `flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition ${theme.secondary.surfaceHover} ${
      isActive ? theme.primary.active : theme.tint.text
    }`
  return (
    <aside className="flex w-56 shrink-0 flex-col p-4">
      <div className="mb-2 flex items-center gap-2 px-3">
        <CircuitryIcon size={28} weight="duotone" className={theme.primary.icon} />
        <span className="font-semibold">Fritzing</span>
      </div>
      <p className={`mb-6 truncate px-3 text-xs ${theme.tint.faint}`} title={currentSketch}>
        {sketchName ?? 'No sketch selected'}
      </p>
      <nav className="flex flex-col gap-1">
        {links.map(({ to, end, icon: Icon, label }) => (
          <NavLink key={to} to={to} end={end} className={navLinkClass}>
            <Icon size={18} />
            {label}
          </NavLink>
        ))}
      </nav>
    </aside>
  )
}
