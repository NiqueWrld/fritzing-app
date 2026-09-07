import { ListIcon } from '@phosphor-icons/react'
import { useState } from 'react'
import { Outlet } from 'react-router-dom'
import Sidebar from '../Sidebar'

function Layout() {
  const [sidebarOpen, setSidebarOpen] = useState(false)

  return (
    <div className="h-screen flex bg-gray-100 dark:bg-gray-900 overflow-hidden">
      {/* Mobile overlay */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 bg-black/50 z-20 md:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}
      {/* Mobile sidebar */}
      <div className={`fixed z-30 top-0 left-0 h-full transition-transform md:hidden bg-gray-100 dark:bg-gray-900 ${
        sidebarOpen ? 'translate-x-0' : '-translate-x-full'
      }`}>
        <Sidebar />
      </div>
      {/* Desktop sidebar */}
      <div className="hidden md:block h-screen sticky top-0">
        <Sidebar />
      </div>
      <div className="flex flex-col flex-1 h-screen overflow-y-auto md:p-2">
        {/* Mobile menu toggle (sidebar is hidden on small screens) */}
        <button
          type="button"
          onClick={() => setSidebarOpen(!sidebarOpen)}
          className="m-2 self-start rounded-lg border border-gray-200 dark:border-gray-700 p-2 md:hidden"
          aria-label="Toggle menu"
        >
          <ListIcon size={20} />
        </button>
        <main className="flex-1 flex flex-col bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700">
          <div className="flex-1 p-4 md:p-6">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  )
}

export default Layout