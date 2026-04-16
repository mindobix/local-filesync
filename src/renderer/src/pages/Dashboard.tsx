import { useEffect, useRef, useState } from 'react'

interface SyncEvent {
  type: string
  filePath?: string
  deviceName?: string
  peerName?: string
  deviceId?: string
  paused?: boolean
  timestamp: number
}

interface ConnectedPeer {
  deviceId: string
  deviceName: string
  address: string
  paused: boolean
}

interface SyncStatus {
  connectedPeers: ConnectedPeer[]
  discoveredPeers: { deviceId: string; deviceName: string; lastSeen: number }[]
  syncPaused: boolean
}

const EVENT_ICONS: Record<string, string> = {
  'peer-connected': '🔗',
  'peer-disconnected': '🔌',
  'file-received': '⬇',
  'file-sent': '⬆',
  'file-deleted': '🗑',
  'sync-paused-changed': '⏸',
  'peer-sync-state': '⏸'
}

const EVENT_COLORS: Record<string, string> = {
  'peer-connected': 'text-green-400',
  'peer-disconnected': 'text-slate-400',
  'file-received': 'text-blue-400',
  'file-sent': 'text-purple-400',
  'file-deleted': 'text-red-400',
  'sync-paused-changed': 'text-amber-400',
  'peer-sync-state': 'text-amber-400'
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  })
}

function eventLabel(ev: SyncEvent): string {
  switch (ev.type) {
    case 'peer-connected':
      return `${ev.deviceName ?? 'Peer'} connected`
    case 'peer-disconnected':
      return `Peer disconnected`
    case 'file-received':
      return `Received ${ev.filePath} from ${ev.peerName ?? 'peer'}`
    case 'file-sent':
      return `Sent ${ev.filePath}`
    case 'file-deleted':
      return `Deleted ${ev.filePath}`
    case 'sync-paused-changed':
      return ev.paused ? 'Sync paused by you' : 'Sync resumed by you'
    case 'peer-sync-state':
      return ev.paused
        ? `${ev.deviceName ?? 'Peer'} paused their sync`
        : `${ev.deviceName ?? 'Peer'} resumed their sync`
    default:
      return ev.type
  }
}

export default function Dashboard() {
  const [events, setEvents] = useState<SyncEvent[]>([])
  const [status, setStatus] = useState<SyncStatus>({
    connectedPeers: [],
    discoveredPeers: [],
    syncPaused: false
  })
  const [watchFolder, setWatchFolder] = useState<string>('')
  const [toggling, setToggling] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)

  const syncPaused = status.syncPaused

  useEffect(() => {
    // Load initial data
    window.api.getSyncStatus().then((s) => setStatus(s as SyncStatus)).catch(() => {})
    window.api.getSettings().then((s) => setWatchFolder(s.watchFolder ?? '')).catch(() => {})
    window.api.getEvents(50).then((evs) => {
      const mapped = (evs as Record<string, unknown>[]).map((e) => ({
        type: e.event_type as string,
        filePath: e.file_path as string,
        peerName: e.peer_name as string | undefined,
        timestamp: e.timestamp as number
      }))
      setEvents(mapped.reverse())
    })

    // Subscribe to live events
    const removeSyncEvent = window.api.onSyncEvent((ev) => {
      setEvents((prev) => [...prev.slice(-199), ev])

      // Keep status in sync for pause-related events without waiting for the poll
      if (ev.type === 'sync-paused-changed') {
        setStatus((prev) => ({ ...prev, syncPaused: ev.paused ?? false }))
      }
      if (ev.type === 'peer-sync-state') {
        setStatus((prev) => ({
          ...prev,
          connectedPeers: prev.connectedPeers.map((p) =>
            p.deviceId === ev.deviceId ? { ...p, paused: ev.paused ?? false } : p
          )
        }))
      }
      if (ev.type === 'peer-connected' || ev.type === 'peer-disconnected') {
        window.api.getSyncStatus().then((s) => setStatus(s as SyncStatus)).catch(() => {})
      }
    })

    const removePeerUpdate = window.api.onPeerUpdate(() => {
      window.api.getSyncStatus().then((s) => setStatus(s as SyncStatus)).catch(() => {})
    })

    // Refresh status periodically
    const interval = setInterval(() => {
      window.api.getSyncStatus().then((s) => setStatus(s as SyncStatus)).catch(() => {})
    }, 5000)

    return () => {
      removeSyncEvent()
      removePeerUpdate()
      clearInterval(interval)
    }
  }, [])

  // Auto-scroll to bottom on new events
  useEffect(() => {
    if (listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight
    }
  }, [events])

  async function handlePauseToggle() {
    setToggling(true)
    try {
      await window.api.setSyncPaused(!syncPaused)
      setStatus((prev) => ({ ...prev, syncPaused: !syncPaused }))
    } finally {
      setToggling(false)
    }
  }

  return (
    <div className="flex flex-col h-full p-4 gap-4">
      {/* Status strip */}
      <div className="flex gap-3">
        <div className="flex-1 bg-slate-800 rounded-lg p-3 flex items-center gap-3">
          <div
            className={`w-2.5 h-2.5 rounded-full ${
              syncPaused
                ? 'bg-amber-400'
                : watchFolder
                  ? 'bg-green-400'
                  : 'bg-slate-500'
            }`}
          />
          <div className="min-w-0">
            <p className="text-xs text-slate-400 uppercase tracking-wide">
              {syncPaused ? 'Sync Paused' : 'Watching'}
            </p>
            <p className="text-sm font-medium truncate">
              {watchFolder || 'No folder selected'}
            </p>
          </div>
        </div>

        <div className="bg-slate-800 rounded-lg p-3 flex items-center gap-3 min-w-36">
          <div className="text-blue-400 text-xl font-bold">
            {status.connectedPeers.length}
          </div>
          <div>
            <p className="text-xs text-slate-400 uppercase tracking-wide">
              Connected
            </p>
            <p className="text-sm font-medium flex items-center gap-1">
              {status.connectedPeers.length === 1 ? 'Peer' : 'Peers'}
              {status.connectedPeers.some((p) => p.paused) && (
                <span className="text-xs text-amber-400" title="One or more peers are paused">
                  ⏸
                </span>
              )}
            </p>
          </div>
        </div>

        <div className="bg-slate-800 rounded-lg p-3 flex items-center gap-3 min-w-36">
          <div className="text-slate-300 text-xl font-bold">
            {status.discoveredPeers.length}
          </div>
          <div>
            <p className="text-xs text-slate-400 uppercase tracking-wide">
              Discovered
            </p>
            <p className="text-sm font-medium">on LAN</p>
          </div>
        </div>

        {/* Open watch folder button */}
        <button
          onClick={() => window.api.openWatchFolder()}
          disabled={!watchFolder}
          title="Open watch folder"
          className="rounded-lg px-4 py-2 text-sm font-medium transition-colors bg-slate-700 hover:bg-slate-600 text-slate-200 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          📂 Open Folder
        </button>

        {/* Pause / Resume button */}
        <button
          onClick={handlePauseToggle}
          disabled={toggling || !watchFolder}
          title={syncPaused ? 'Resume sync' : 'Pause sync'}
          className={`rounded-lg px-4 py-2 text-sm font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
            syncPaused
              ? 'bg-amber-500 hover:bg-amber-400 text-slate-900'
              : 'bg-slate-700 hover:bg-slate-600 text-slate-200'
          }`}
        >
          {syncPaused ? '▶ Resume' : '⏸ Pause'}
        </button>
      </div>

      {/* Paused banner */}
      {syncPaused && (
        <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg px-4 py-2 text-amber-300 text-sm flex items-center gap-2">
          <span>⏸</span>
          <span>
            Sync is paused — no files will be sent or received until you resume.
          </span>
        </div>
      )}

      {/* Event log */}
      <div className="flex-1 bg-slate-800 rounded-lg flex flex-col min-h-0">
        <div className="px-4 py-2 border-b border-slate-700 flex items-center justify-between">
          <span className="text-sm font-medium text-slate-300">
            Activity Log
          </span>
          <button
            onClick={() => setEvents([])}
            className="text-xs text-slate-500 hover:text-slate-300 transition-colors"
          >
            Clear
          </button>
        </div>

        <div ref={listRef} className="flex-1 overflow-y-auto p-2">
          {events.length === 0 ? (
            <div className="flex items-center justify-center h-full text-slate-500 text-sm">
              No activity yet
            </div>
          ) : (
            <div className="space-y-0.5">
              {events.map((ev, i) => (
                <div
                  key={i}
                  className="flex items-start gap-2 px-2 py-1 rounded hover:bg-slate-700/50 text-sm"
                >
                  <span className="text-base w-5 text-center flex-shrink-0">
                    {EVENT_ICONS[ev.type] ?? '·'}
                  </span>
                  <span
                    className={`flex-1 ${EVENT_COLORS[ev.type] ?? 'text-slate-300'}`}
                  >
                    {eventLabel(ev)}
                  </span>
                  <span className="text-xs text-slate-500 flex-shrink-0 tabular-nums">
                    {formatTime(ev.timestamp)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
