import { useState } from 'react'
import Dashboard from './pages/Dashboard'
import Peers from './pages/Peers'
import Settings from './pages/Settings'

type Tab = 'dashboard' | 'peers' | 'settings'

const tabs: { id: Tab; label: string }[] = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'peers', label: 'Peers' },
  { id: 'settings', label: 'Settings' }
]

export default function App() {
  const [activeTab, setActiveTab] = useState<Tab>('dashboard')

  return (
    <div className="flex flex-col h-screen bg-slate-900 text-slate-200">
      {/* Title bar drag region (macOS) */}
      <div
        className="h-8 bg-slate-950 flex-shrink-0"
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      />

      {/* Tab navigation */}
      <nav
        className="flex gap-1 px-4 pb-0 bg-slate-950 border-b border-slate-700"
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      >
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`px-4 py-2 text-sm font-medium rounded-t transition-colors ${
              activeTab === tab.id
                ? 'bg-slate-800 text-blue-400 border-b-2 border-blue-400'
                : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/50'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </nav>

      {/* Page content */}
      <main className="flex-1 overflow-hidden">
        {activeTab === 'dashboard' && <Dashboard />}
        {activeTab === 'peers' && <Peers />}
        {activeTab === 'settings' && <Settings />}
      </main>
    </div>
  )
}
