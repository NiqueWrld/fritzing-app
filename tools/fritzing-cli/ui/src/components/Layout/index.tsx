import { Outlet } from 'react-router-dom'
import { useSketch } from '../../context/SketchContext'
import Sidebar from '../Sidebar'

export default function Layout() {
  const { currentSketch } = useSketch()
  return (
    <div className="flex min-h-screen bg-slate-950 text-slate-100">
      <Sidebar />
      <div className="flex-1">
        <header className="border-b border-slate-800 px-8 py-6">
          <h1 className="text-2xl font-semibold">Fritzing Workspace</h1>
          <p className="mt-1 truncate text-sm text-slate-400">
            {currentSketch ?? 'No sketch selected — pick one on the Sketches page'}
          </p>
        </header>
        <main className="p-8">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
