import { ipcMain, dialog, BrowserWindow, app } from 'electron'
import os from 'os'
import { getSettings, getSetting, setSetting, getPeers, getSyncEvents } from './db'
import { startWatcher, stopWatcher } from './watcher'
import { startSyncServer, stopSyncServer, getConnectedPeers, connectToPeer } from './sync'
import { startDiscovery, stopDiscovery, getKnownPeers } from './discovery'

export function registerIpcHandlers(): void {
  ipcMain.handle('get-settings', () => getSettings())

  ipcMain.handle(
    'save-settings',
    (_, settings: Record<string, string>) => {
      for (const [key, value] of Object.entries(settings)) {
        setSetting(key, value)
      }

      if ('watchFolder' in settings) {
        if (settings.watchFolder) {
          startWatcher(settings.watchFolder)
        } else {
          stopWatcher()
        }
      }

      if ('syncPort' in settings) {
        const port = parseInt(getSetting('syncPort') ?? '9876', 10)
        stopSyncServer()
        startSyncServer(port)
      }

      if ('deviceName' in settings || 'syncPort' in settings) {
        stopDiscovery()
        const deviceId = getSetting('deviceId') ?? ''
        const deviceName = getSetting('deviceName') ?? 'Unknown'
        const syncPort = parseInt(getSetting('syncPort') ?? '9876', 10)
        startDiscovery(deviceId, deviceName, syncPort)
      }

      if ('autoLaunch' in settings) {
        try {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const AutoLaunch = require('electron-auto-launch')
          const launcher = new AutoLaunch({
            name: 'local-filesync',
            path: app.getPath('exe')
          })
          if (settings.autoLaunch === 'true') {
            launcher.enable()
          } else {
            launcher.disable()
          }
        } catch {
          // auto-launch not critical
        }
      }

      return { success: true }
    }
  )

  ipcMain.handle('get-peers', () => getPeers())

  ipcMain.handle('get-events', (_, limit?: number) => getSyncEvents(limit))

  ipcMain.handle('select-folder', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const result = await dialog.showOpenDialog(win!, {
      properties: ['openDirectory']
    })
    return result.canceled ? null : result.filePaths[0]
  })

  ipcMain.handle('get-sync-status', () => ({
    connectedPeers: getConnectedPeers(),
    discoveredPeers: getKnownPeers()
  }))

  ipcMain.handle('get-local-ips', () => {
    const ips: string[] = []
    for (const iface of Object.values(os.networkInterfaces())) {
      if (!iface) continue
      for (const addr of iface) {
        if (addr.family === 'IPv4' && !addr.internal) {
          ips.push(addr.address)
        }
      }
    }
    return ips
  })

  ipcMain.handle('connect-to-peer-manual', (_, address: string, port: number) => {
    const manualId = `manual-${address}`
    connectToPeer(manualId, address, port)
    return { ok: true }
  })
}
