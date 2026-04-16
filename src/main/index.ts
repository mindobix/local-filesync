import { app, BrowserWindow, Tray, Menu, nativeImage, shell } from 'electron'
import path from 'path'
import os from 'os'
import { v4 as uuidv4 } from 'uuid'
import { initDB, getSetting, setSetting, addSyncEvent, upsertPeer, getPeers } from './db'
import {
  startDiscovery,
  stopDiscovery,
  discoveryEvents,
  getKnownPeers
} from './discovery'
import {
  startSyncServer,
  stopSyncServer,
  connectToPeer,
  requestSyncFromPeer,
  getConnectedPeers,
  syncEvents,
  setMyDeviceId
} from './sync'
import { startWatcher, stopWatcher } from './watcher'
import { registerIpcHandlers } from './ipc'
import {
  startClipboardSync,
  stopClipboardSync,
  applyClipboardFromPeer,
  setClipboardDeviceId,
  type ClipboardPayload
} from './clipboard'

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let isQuitting = false

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 860,
    height: 600,
    minWidth: 700,
    minHeight: 500,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true
    },
    show: false,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    title: 'FileSync',
    backgroundColor: '#0f172a',
    icon: createTrayIcon()
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }

  mainWindow.once('ready-to-show', () => mainWindow?.show())

  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault()
      mainWindow?.hide()
    }
  })
}

function buildTrayMenu(): Electron.Menu {
  const peers = getKnownPeers()
  const watchFolder = getSetting('watchFolder') ?? ''
  return Menu.buildFromTemplate([
    { label: 'FileSync', enabled: false },
    { type: 'separator' },
    {
      label: 'Open',
      click: () => {
        mainWindow?.show()
        mainWindow?.focus()
      }
    },
    {
      label: 'Open Watch Folder',
      enabled: !!watchFolder,
      click: () => { if (watchFolder) shell.openPath(watchFolder) }
    },
    { type: 'separator' },
    {
      label: `Peers discovered: ${peers.length}`,
      enabled: false
    },
    { type: 'separator' },
    {
      label: 'Quit FileSync',
      click: () => {
        isQuitting = true
        app.quit()
      }
    }
  ])
}

function createTrayIcon(): Electron.NativeImage {
  const size = 16
  const buf = Buffer.alloc(size * size * 4, 0)
  const cx = 7.5
  const cy = 7.5
  const outerR2 = 7 * 7
  const innerR2 = 4 * 4

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - cx
      const dy = y - cy
      const d2 = dx * dx + dy * dy
      if (d2 <= outerR2 && d2 >= innerR2) {
        const i = (y * size + x) * 4
        buf[i] = 0; buf[i + 1] = 0; buf[i + 2] = 0; buf[i + 3] = 255
      }
    }
  }

  const img = nativeImage.createFromBuffer(buf, { width: size, height: size })
  if (process.platform === 'darwin') img.setTemplateImage(true)
  return img
}

function createTray(): void {
  const icon = createTrayIcon()
  tray = new Tray(icon)
  tray.setToolTip('FileSync — LAN File Sync')
  tray.setContextMenu(buildTrayMenu())

  tray.on('click', () => {
    mainWindow?.show()
    mainWindow?.focus()
  })

  setInterval(() => {
    tray?.setContextMenu(buildTrayMenu())
  }, 15_000)
}

function notifyRenderer(channel: string, ...args: unknown[]): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, ...args)
  }
}

async function main(): Promise<void> {
  // Ensure this device has a stable ID
  let deviceId = getSetting('deviceId')
  if (!deviceId) {
    deviceId = uuidv4()
    setSetting('deviceId', deviceId)
  }
  setMyDeviceId(deviceId)
  setClipboardDeviceId(deviceId)

  const syncPort = parseInt(getSetting('syncPort') ?? '9876', 10)
  const watchFolder = getSetting('watchFolder') ?? ''

  startSyncServer(syncPort)
  startDiscovery(deviceId, getSetting('deviceName') ?? 'Unknown', syncPort)

  // macOS 15 local network privacy can silently block incoming UDP broadcasts
  // from non-Apple peers (e.g. Windows). As a fallback, reconnect directly to
  // any peers seen in the last 7 days, bypassing UDP discovery entirely.
  const darwinMajor = process.platform === 'darwin'
    ? parseInt(os.release().split('.')[0], 10)
    : 0
  if (darwinMajor >= 24) {
    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000
    setTimeout(() => {
      for (const p of getPeers().filter((peer) => peer.last_seen > sevenDaysAgo)) {
        console.log(`[mac15] reconnecting to known peer: ${p.name} (${p.address}:${p.port})`)
        connectToPeer(p.id, p.address, p.port)
      }
    }, 3000)
  }

  if (watchFolder) {
    startWatcher(watchFolder)
    startClipboardSync(watchFolder)
  }

  discoveryEvents.on('peer', (peer) => {
    upsertPeer(peer.deviceId, peer.deviceName, peer.address, peer.syncPort)
    connectToPeer(peer.deviceId, peer.address, peer.syncPort)
    notifyRenderer('peer-update', peer)
    tray?.setContextMenu(buildTrayMenu())
  })

  // When a peer sends their hello (inbound or outbound), persist their
  // address + syncPort so mac15 can reconnect to them on next startup
  // even if UDP discovery is blocked by macOS 15 local network privacy.
  syncEvents.on('peer-connected', (deviceId: string, deviceName: string, address: string, syncPort: number | null) => {
    if (address && syncPort) {
      upsertPeer(deviceId, deviceName, address, syncPort)
    }
    addSyncEvent('', 'peer-connected', deviceId, deviceName)
    notifyRenderer('sync-event', {
      type: 'peer-connected',
      deviceName,
      timestamp: Date.now()
    })
    // Wait for the hello exchange to complete, then request their file list
    // so we pull anything we missed while this peer was offline.
    setTimeout(() => requestSyncFromPeer(deviceId), 1500)
  })

  // Periodic catch-up sync every 5 minutes — pulls file lists from all
  // connected peers to catch any changes missed due to network gaps.
  setInterval(() => {
    for (const peer of getConnectedPeers()) {
      requestSyncFromPeer(peer.deviceId)
    }
  }, 5 * 60 * 1000)

  syncEvents.on('peer-disconnected', (deviceId: string) => {
    notifyRenderer('sync-event', {
      type: 'peer-disconnected',
      deviceId,
      timestamp: Date.now()
    })
  })

  syncEvents.on('file-received', (filePath: string, peerName: string) => {
    notifyRenderer('sync-event', {
      type: 'file-received',
      filePath,
      peerName,
      timestamp: Date.now()
    })
  })

  syncEvents.on('file-sent', (filePath: string) => {
    notifyRenderer('sync-event', {
      type: 'file-sent',
      filePath,
      timestamp: Date.now()
    })
  })

  syncEvents.on('file-deleted', (filePath: string) => {
    notifyRenderer('sync-event', {
      type: 'file-deleted',
      filePath,
      timestamp: Date.now()
    })
  })

  syncEvents.on('sync-paused-changed', (paused: boolean) => {
    notifyRenderer('sync-event', {
      type: 'sync-paused-changed',
      paused,
      timestamp: Date.now()
    })
  })

  syncEvents.on('clipboard-received', (payload: ClipboardPayload) => {
    applyClipboardFromPeer(payload)
  })

  syncEvents.on('peer-sync-state', (deviceId: string, deviceName: string, paused: boolean) => {
    notifyRenderer('sync-event', {
      type: 'peer-sync-state',
      deviceId,
      deviceName,
      paused,
      timestamp: Date.now()
    })
  })
}

app.whenReady().then(() => {
  // Init DB and register IPC handlers BEFORE creating the window so the
  // renderer never hits "No handler registered" regardless of timing.
  try {
    initDB()
  } catch (e) {
    console.error('[Main] DB init failed:', e)
  }
  registerIpcHandlers()

  createWindow()
  createTray()
  main()

  app.on('activate', () => {
    mainWindow?.show()
    mainWindow?.focus()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    // keep alive in tray
  }
})

app.on('before-quit', () => {
  isQuitting = true
  stopDiscovery()
  stopSyncServer()
  stopWatcher()
  stopClipboardSync()
})
