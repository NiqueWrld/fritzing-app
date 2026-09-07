import { CircuitryIcon, FolderOpenIcon, LightningIcon, MagnifyingGlassIcon } from '@phosphor-icons/react'

const tools = [
  { icon: FolderOpenIcon, name: 'list-sketches', description: 'List .fz and .fzz sketches in the workspace.' },
  { icon: MagnifyingGlassIcon, name: 'inspect-sketch', description: 'Show metadata for a selected sketch.' },
  { icon: CircuitryIcon, name: 'find-parts', description: 'Search installed part definitions and moduleIds.' },
  { icon: LightningIcon, name: 'snapshot-project', description: 'Export a live SVG snapshot of a project.' },
]

export default function App() {
  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <header className="border-b border-slate-800 px-8 py-6">
        <h1 className="flex items-center gap-3 text-2xl font-semibold">
          <CircuitryIcon size={32} weight="duotone" className="text-sky-400" />
          Fritzing CLI UI
        </h1>
        <p className="mt-1 text-sm text-slate-400">Vite + Tailwind CSS + Phosphor Icons</p>
      </header>
      <main className="mx-auto grid max-w-4xl gap-4 p-8 sm:grid-cols-2">
        {tools.map(({ icon: Icon, name, description }) => (
          <section key={name} className="rounded-xl border border-slate-800 bg-slate-900 p-5 transition hover:border-sky-500">
            <Icon size={28} weight="duotone" className="text-sky-400" />
            <h2 className="mt-3 font-mono text-lg font-medium">{name}</h2>
            <p className="mt-1 text-sm text-slate-400">{description}</p>
          </section>
        ))}
      </main>
    </div>
  )
}
