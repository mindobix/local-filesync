interface SyncEventPayload {
  type: string
  filePath?: string
  deviceName?: string
  peerName?: string
  deviceId?: string
  timestamp: number
}

interface PeerInfoPayload {
  deviceId: string
  deviceName: string
  address: string
  syncPort: number
  lastSeen: number
}

interface Window {
  api: {
    getSettings: () => Promise<Record<string, string>>
    saveSettings: (settings: Record<string, string>) => Promise<{ success: boolean }>
    getPeers: () => Promise<unknown[]>
    getEvents: (limit?: number) => Promise<unknown[]>
    selectFolder: () => Promise<string | null>
    getSyncStatus: () => Promise<{
      connectedPeers: { deviceId: string; deviceName: string; address: string }[]
      discoveredPeers: PeerInfoPayload[]
    }>
    getLocalIps: () => Promise<string[]>
    connectToPeerManual: (address: string, port: number) => Promise<{ ok: boolean }>
    setSyncPaused: (paused: boolean) => Promise<{ ok: boolean }>
    openWatchFolder: () => Promise<void>
    onSyncEvent: (callback: (event: SyncEventPayload) => void) => () => void
    onPeerUpdate: (callback: (peer: PeerInfoPayload) => void) => () => void
  }
}
