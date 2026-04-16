import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('api', {
  getSettings: () => ipcRenderer.invoke('get-settings'),

  saveSettings: (settings: Record<string, string>) =>
    ipcRenderer.invoke('save-settings', settings),

  getPeers: () => ipcRenderer.invoke('get-peers'),

  getEvents: (limit?: number) => ipcRenderer.invoke('get-events', limit),

  selectFolder: () => ipcRenderer.invoke('select-folder'),

  getSyncStatus: () => ipcRenderer.invoke('get-sync-status'),

  getLocalIps: () => ipcRenderer.invoke('get-local-ips'),

  connectToPeerManual: (address: string, port: number) =>
    ipcRenderer.invoke('connect-to-peer-manual', address, port),

  openWatchFolder: () => ipcRenderer.invoke('open-watch-folder'),

  setSyncPaused: (paused: boolean) => ipcRenderer.invoke('set-sync-paused', paused),

  onSyncEvent: (callback: (event: SyncEvent) => void) => {
    const listener = (_: Electron.IpcRendererEvent, event: SyncEvent) =>
      callback(event)
    ipcRenderer.on('sync-event', listener)
    return () => ipcRenderer.removeListener('sync-event', listener)
  },

  onPeerUpdate: (callback: (peer: PeerInfo) => void) => {
    const listener = (_: Electron.IpcRendererEvent, peer: PeerInfo) =>
      callback(peer)
    ipcRenderer.on('peer-update', listener)
    return () => ipcRenderer.removeListener('peer-update', listener)
  }
})

interface SyncEvent {
  type: string
  filePath?: string
  deviceId?: string
  deviceName?: string
  peerName?: string
  paused?: boolean
  timestamp: number
}

interface PeerInfo {
  deviceId: string
  deviceName: string
  address: string
  syncPort: number
  lastSeen: number
}
