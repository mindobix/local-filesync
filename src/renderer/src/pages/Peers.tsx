import { useEffect, useState } from 'react'

interface ConnectedPeer {
  deviceId: string
  deviceName: string
  address: string
}

interface DiscoveredPeer {
  deviceId: string
  deviceName: string
  address: string
  syncPort: number
  lastSeen: number
}

interface SyncStatus {
  connectedPeers: ConnectedPeer[]
  discoveredPeers: DiscoveredPeer[]
}

function timeAgo(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000)
  if (s < 10) return 'just now'
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  return `${Math.floor(s / 3600)}h ago`
}

export default function Peers() {
  const [status, setStatus] = useState<SyncStatus>({
    connectedPeers: [],
    discoveredPeers: []
  })

  const refresh = () => window.api.getSyncStatus().then(setStatus)

  useEffect(() => {
    refresh()

    const removePeerUpdate = window.api.onPeerUpdate(() => refresh())
    const removeSyncEvent = window.api.onSyncEvent((ev) => {
      if (
        ev.type === 'peer-connected' ||
        ev.type === 'peer-disconnected'
      ) {
        refresh()
      }
    })
    const interval = setInterval(refresh, 5000)

    return () => {
      removePeerUpdate()
      removeSyncEvent()
      clearInterval(interval)
    }
  }, [])

  const connectedIds = new Set(status.connectedPeers.map((p) => p.deviceId))

  return (
    <div className="h-full overflow-y-auto p-4 space-y-4">
      {/* Connected peers */}
      <section>
        <h2 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">
          Connected ({status.connectedPeers.length})
        </h2>

        {status.connectedPeers.length === 0 ? (
          <div className="bg-slate-800 rounded-lg p-4 text-sm text-slate-500 text-center">
            No peers connected
          </div>
        ) : (
          <div className="space-y-2">
            {status.connectedPeers.map((peer) => (
              <div
                key={peer.deviceId}
                className="bg-slate-800 rounded-lg px-4 py-3 flex items-center gap-3"
              >
                <div className="w-2.5 h-2.5 rounded-full bg-green-400 flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="font-medium text-slate-200 truncate">
                    {peer.deviceName}
                  </p>
                  <p className="text-xs text-slate-400 font-mono">
                    {peer.address}
                  </p>
                </div>
                <span className="text-xs bg-green-900/40 text-green-400 px-2 py-0.5 rounded-full">
                  Connected
                </span>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Discovered peers */}
      <section>
        <h2 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">
          Discovered on LAN ({status.discoveredPeers.length})
        </h2>

        {status.discoveredPeers.length === 0 ? (
          <div className="bg-slate-800 rounded-lg p-4 text-sm text-slate-500 text-center">
            Scanning local network...
          </div>
        ) : (
          <div className="space-y-2">
            {status.discoveredPeers.map((peer) => {
              const isConnected = connectedIds.has(peer.deviceId)
              return (
                <div
                  key={peer.deviceId}
                  className="bg-slate-800 rounded-lg px-4 py-3 flex items-center gap-3"
                >
                  <div
                    className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${
                      isConnected ? 'bg-green-400' : 'bg-yellow-400'
                    }`}
                  />
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-slate-200 truncate">
                      {peer.deviceName}
                    </p>
                    <p className="text-xs text-slate-400 font-mono">
                      {peer.address}:{peer.syncPort}
                    </p>
                  </div>
                  <div className="text-right flex-shrink-0">
                    <span
                      className={`text-xs px-2 py-0.5 rounded-full ${
                        isConnected
                          ? 'bg-green-900/40 text-green-400'
                          : 'bg-yellow-900/40 text-yellow-400'
                      }`}
                    >
                      {isConnected ? 'Connected' : 'Discovered'}
                    </span>
                    <p className="text-xs text-slate-500 mt-0.5">
                      {timeAgo(peer.lastSeen)}
                    </p>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </section>

      <div className="text-center">
        <button
          onClick={refresh}
          className="text-xs text-slate-500 hover:text-slate-300 transition-colors"
        >
          Refresh
        </button>
      </div>
    </div>
  )
}
