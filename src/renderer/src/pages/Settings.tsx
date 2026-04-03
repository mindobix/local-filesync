import { useEffect, useState } from 'react'

interface Settings {
  watchFolder: string
  deviceName: string
  syncPort: string
  autoLaunch: string
}

export default function Settings() {
  const [settings, setSettings] = useState<Settings>({
    watchFolder: '',
    deviceName: '',
    syncPort: '9876',
    autoLaunch: 'false'
  })
  const [saved, setSaved] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    window.api.getSettings().then((s) => {
      setSettings({
        watchFolder: s.watchFolder ?? '',
        deviceName: s.deviceName ?? '',
        syncPort: s.syncPort ?? '9876',
        autoLaunch: s.autoLaunch ?? 'false'
      })
    })
  }, [])

  const update = (key: keyof Settings, value: string) => {
    setSettings((prev) => ({ ...prev, [key]: value }))
    setSaved(false)
  }

  const selectFolder = async () => {
    const folder = await window.api.selectFolder()
    if (folder) update('watchFolder', folder)
  }

  const save = async () => {
    setSaving(true)
    try {
      await window.api.saveSettings(settings)
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="max-w-lg space-y-6">
        {/* Watch folder */}
        <div>
          <label className="block text-sm font-medium text-slate-300 mb-1.5">
            Watch Folder
          </label>
          <p className="text-xs text-slate-500 mb-2">
            Files in this folder will be synced with connected peers.
          </p>
          <div className="flex gap-2">
            <input
              type="text"
              value={settings.watchFolder}
              onChange={(e) => update('watchFolder', e.target.value)}
              placeholder="/path/to/folder"
              className="flex-1 bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-sm text-slate-200 placeholder-slate-500 focus:outline-none focus:border-blue-500"
            />
            <button
              onClick={selectFolder}
              className="px-3 py-2 bg-slate-700 hover:bg-slate-600 border border-slate-600 rounded-lg text-sm text-slate-300 transition-colors whitespace-nowrap"
            >
              Browse...
            </button>
          </div>
        </div>

        {/* Device name */}
        <div>
          <label className="block text-sm font-medium text-slate-300 mb-1.5">
            Device Name
          </label>
          <p className="text-xs text-slate-500 mb-2">
            How this device appears to other peers on the network.
          </p>
          <input
            type="text"
            value={settings.deviceName}
            onChange={(e) => update('deviceName', e.target.value)}
            placeholder="My Mac"
            className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-sm text-slate-200 placeholder-slate-500 focus:outline-none focus:border-blue-500"
          />
        </div>

        {/* Sync port */}
        <div>
          <label className="block text-sm font-medium text-slate-300 mb-1.5">
            Sync Port
          </label>
          <p className="text-xs text-slate-500 mb-2">
            WebSocket port for file transfers. Must match across all devices.
          </p>
          <input
            type="number"
            value={settings.syncPort}
            onChange={(e) => update('syncPort', e.target.value)}
            min={1024}
            max={65535}
            className="w-32 bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-blue-500"
          />
        </div>

        {/* Auto-launch */}
        <div className="flex items-start gap-3">
          <input
            type="checkbox"
            id="autoLaunch"
            checked={settings.autoLaunch === 'true'}
            onChange={(e) =>
              update('autoLaunch', e.target.checked ? 'true' : 'false')
            }
            className="mt-0.5 w-4 h-4 rounded accent-blue-500"
          />
          <div>
            <label
              htmlFor="autoLaunch"
              className="block text-sm font-medium text-slate-300 cursor-pointer"
            >
              Launch at login
            </label>
            <p className="text-xs text-slate-500">
              Automatically start FileSync when you log in.
            </p>
          </div>
        </div>

        {/* Save button */}
        <div className="pt-2">
          <button
            onClick={save}
            disabled={saving}
            className={`px-6 py-2 rounded-lg text-sm font-medium transition-colors ${
              saved
                ? 'bg-green-600 text-white'
                : 'bg-blue-600 hover:bg-blue-500 text-white disabled:opacity-50'
            }`}
          >
            {saved ? 'Saved!' : saving ? 'Saving...' : 'Save Settings'}
          </button>
        </div>
      </div>
    </div>
  )
}
