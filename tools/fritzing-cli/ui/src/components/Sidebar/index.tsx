import { CircuitryIcon, CpuIcon, FileCodeIcon, PuzzlePieceIcon } from '@phosphor-icons/react'
import { NavLink } from 'react-router-dom'
import { useSketch } from '../../context/SketchContext'

const links = [
  { to: '/', end: true, icon: FileCodeIcon, label: 'Sketches' },
  { to: '/parts', end: false, icon: PuzzlePieceIcon, label: 'Parts' },
  { to: '/breadboard', end: false, icon: CpuIcon, label: 'Breadboard' },
]

const navLinkClass = ({ isActive }: { isActive: boolean }) =>
  `flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition hover:bg-slate-900 ${
    isActive ? 'bg-slate-900 text-sky-300' : 'text-slate-300'
  }`

export default function Sidebar() {
  const { currentSketch } = useSketch()
  const sketchName = currentSketch?.split(/[\\/]/).pop()
  return (
    <aside className="flex w-56 shrink-0 flex-col border-r border-slate-800 p-4">
      <div className="mb-2 flex items-center gap-2 px-3">
        <CircuitryIcon size={28} weight="duotone" className="text-sky-400" />
        <span className="font-semibold">Fritzing</span>
      </div>
      <p className="mb-6 truncate px-3 text-xs text-slate-500" title={currentSketch}>
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
