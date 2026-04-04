import { useEffect, useRef, useState } from 'react'

interface SyncEvent {
  type: string
  filePath?: string
  deviceName?: string
  peerName?: string
  deviceId?: string
  timestamp: number
}

interface SyncStatus {
  connectedPeers: { deviceId: string; deviceName: string; address: string }[]
  discoveredPeers: { deviceId: string; deviceName: string; lastSeen: number }[]
}

const EVENT_ICONS: Record<string, string> = {
  'peer-connected': '🔗',
  'peer-disconnected': '🔌',
  'file-received': '⬇',
  'file-sent': '⬆',
  'file-deleted': '🗑'
}

const EVENT_COLORS: Record<string, string> = {
  'peer-connected': 'text-green-400',
  'peer-disconnected': 'text-slate-400',
  'file-received': 'text-blue-400',
  'file-sent': 'text-purple-400',
  'file-deleted': 'text-red-400'
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
    default:
      return ev.type
  }
}

export default function Dashboard() {
  const [events, setEvents] = useState<SyncEvent[]>([])
  const [status, setStatus] = useState<SyncStatus>({
    connectedPeers: [],
    discoveredPeers: []
  })
  const [watchFolder, setWatchFolder] = useState<string>('')
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    // Load initial data
    window.api.getSyncStatus().then(setStatus).catch(() => {})
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
    })

    const removePeerUpdate = window.api.onPeerUpdate(() => {
      window.api.getSyncStatus().then(setStatus)
    })

    // Refresh status periodically
    const interval = setInterval(() => {
      window.api.getSyncStatus().then(setStatus)
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

  return (
    <div className="flex flex-col h-full p-4 gap-4">
      {/* Status strip */}
      <div className="flex gap-3">
        <div className="flex-1 bg-slate-800 rounded-lg p-3 flex items-center gap-3">
          <div
            className={`w-2.5 h-2.5 rounded-full ${watchFolder ? 'bg-green-400' : 'bg-slate-500'}`}
          />
          <div className="min-w-0">
            <p className="text-xs text-slate-400 uppercase tracking-wide">
              Watching
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
            <p className="text-sm font-medium">
              {status.connectedPeers.length === 1 ? 'Peer' : 'Peers'}
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
      </div>

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
