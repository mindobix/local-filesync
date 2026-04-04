import { useEffect, useRef, useState } from 'react'

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

// Peers older than this are purged by the main process
const STALE_MS = 30_000

function timeAgo(ts: number, now: number): string {
  const s = Math.floor((now - ts) / 1000)
  if (s < 10) return 'just now'
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  return `${Math.floor(s / 3600)}h ago`
}

// Green → yellow → red as the peer approaches the 30s stale cutoff
function freshnessColor(lastSeen: number, now: number): string {
  const age = now - lastSeen
  if (age < STALE_MS * 0.4) return 'text-green-400'   // <12s
  if (age < STALE_MS * 0.75) return 'text-yellow-400' // 12–22s
  return 'text-red-400'                                // 22–30s
}

export default function Peers() {
  const [status, setStatus] = useState<SyncStatus>({
    connectedPeers: [],
    discoveredPeers: []
  })
  const [localIps, setLocalIps] = useState<string[]>([])
  const [manualAddress, setManualAddress] = useState('')
  const [manualPort, setManualPort] = useState('9876')
  const [manualStatus, setManualStatus] = useState('')
  const [now, setNow] = useState(Date.now())
  const [refreshing, setRefreshing] = useState(false)
  // Keep a stable ref so the status ticker doesn't re-create on each render
  const refreshRef = useRef<() => void>(() => {})

  const refresh = () =>
    window.api.getSyncStatus().then(setStatus).catch(() => {})

  const handleRefresh = () => {
    setRefreshing(true)
    window.api.getSyncStatus()
      .then(setStatus)
      .finally(() => setRefreshing(false))
  }

  useEffect(() => {
    refreshRef.current = refresh
  })

  useEffect(() => {
    refresh()
    window.api.getLocalIps().then(setLocalIps).catch(() => {})

    // Retry on startup so peers that connect just after the UI loads are shown
    // without waiting for the 8s poll — covers the race between renderer ready
    // and the WebSocket hello exchange completing with cross-platform peers.
    const startupRetry2s = setTimeout(() => refreshRef.current(), 2000)
    const startupRetry5s = setTimeout(() => refreshRef.current(), 5000)

    const removePeerUpdate = window.api.onPeerUpdate(() => refresh())
    const removeSyncEvent = window.api.onSyncEvent((ev) => {
      if (
        ev.type === 'peer-connected' ||
        ev.type === 'peer-disconnected' ||
        ev.type === 'file-received'
      ) {
        refresh()
      }
    })

    // Fetch fresh peer data every 8s
    const statusInterval = setInterval(() => refreshRef.current(), 8000)
    // Tick every second so "last seen" text and freshness colours update live
    const clockInterval = setInterval(() => setNow(Date.now()), 1000)

    return () => {
      clearTimeout(startupRetry2s)
      clearTimeout(startupRetry5s)
      removePeerUpdate()
      removeSyncEvent()
      clearInterval(statusInterval)
      clearInterval(clockInterval)
    }
  }, [])

  const connectedIds = new Set(status.connectedPeers.map((p) => p.deviceId))

  const handleManualConnect = async () => {
    const address = manualAddress.trim()
    const port = parseInt(manualPort, 10)
    if (!address || isNaN(port)) {
      setManualStatus('Enter a valid IP and port.')
      return
    }
    setManualStatus('Connecting...')
    try {
      await window.api.connectToPeerManual(address, port)
      setManualStatus('Connection initiated — check Connected list.')
      setTimeout(() => refresh(), 2000)
    } catch (e) {
      setManualStatus('Failed: ' + String(e))
    }
  }

  return (
    <div className="h-full overflow-y-auto p-4 space-y-4">

      {/* This device info */}
      {localIps.length > 0 && (
        <section>
          <h2 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">
            This Device
          </h2>
          <div className="bg-slate-800 rounded-lg px-4 py-3">
            <p className="text-xs text-slate-400 mb-1">Local IP{localIps.length > 1 ? 's' : ''} (share with other Mac)</p>
            {localIps.map((ip) => (
              <p key={ip} className="text-sm font-mono text-slate-200">{ip}</p>
            ))}
          </div>
        </section>
      )}

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
            Scanning local network... (if nothing appears, use manual connect below)
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
                    <p className={`text-xs mt-0.5 tabular-nums ${freshnessColor(peer.lastSeen, now)}`}>
                      {timeAgo(peer.lastSeen, now)}
                    </p>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </section>

      {/* Manual connect */}
      <section>
        <h2 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">
          Manual Connect
        </h2>
        <div className="bg-slate-800 rounded-lg p-4 space-y-3">
          <p className="text-xs text-slate-400">
            If auto-discovery is blocked by your router, enter the other Mac's IP address directly.
          </p>
          <div className="flex gap-2">
            <input
              type="text"
              placeholder="192.168.1.x"
              value={manualAddress}
              onChange={(e) => setManualAddress(e.target.value)}
              className="flex-1 bg-slate-700 text-slate-200 text-sm rounded px-3 py-1.5 outline-none focus:ring-1 focus:ring-blue-500 font-mono"
            />
            <input
              type="number"
              placeholder="9876"
              value={manualPort}
              onChange={(e) => setManualPort(e.target.value)}
              className="w-20 bg-slate-700 text-slate-200 text-sm rounded px-3 py-1.5 outline-none focus:ring-1 focus:ring-blue-500 font-mono"
            />
            <button
              onClick={handleManualConnect}
              className="bg-blue-600 hover:bg-blue-500 text-white text-sm rounded px-4 py-1.5 transition-colors"
            >
              Connect
            </button>
          </div>
          {manualStatus && (
            <p className="text-xs text-slate-400">{manualStatus}</p>
          )}
        </div>
      </section>

      <div className="text-center">
        <button
          onClick={handleRefresh}
          disabled={refreshing}
          className="text-xs text-slate-500 hover:text-slate-300 transition-colors disabled:opacity-50"
        >
          {refreshing ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>
    </div>
  )
}
