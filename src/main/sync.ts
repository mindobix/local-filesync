import WebSocket, { WebSocketServer } from 'ws'
import fs from 'fs'
import path from 'path'
import { EventEmitter } from 'events'
import { addSyncEvent, getSetting } from './db'
import { markSyncWrite } from './watcher'

export const syncEvents = new EventEmitter()

interface ConnectedPeer {
  ws: WebSocket
  deviceId: string
  deviceName: string
  address: string
}

let wss: WebSocketServer | null = null
const connectedPeers = new Map<string, ConnectedPeer>()
const connectingPeers = new Set<string>()
let myDeviceId = ''

export function setMyDeviceId(id: string): void {
  myDeviceId = id
}

function sendJSON(ws: WebSocket, data: unknown): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data))
  }
}

function safeRelPath(
  watchFolder: string,
  requestedPath: string
): string | null {
  const rel = path.normalize(requestedPath)
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null
  return rel
}

function getFileList(
  watchFolder: string
): { path: string; mtime: number; size: number }[] {
  const results: { path: string; mtime: number; size: number }[] = []

  function scan(dir: string) {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        scan(full)
      } else if (entry.isFile()) {
        try {
          const stat = fs.statSync(full)
          if (stat.size < 100 * 1024 * 1024) {
            results.push({
              path: path.relative(watchFolder, full),
              mtime: stat.mtimeMs,
              size: stat.size
            })
          }
        } catch {
          // skip unreadable files
        }
      }
    }
  }

  scan(watchFolder)
  return results
}

async function handleMessage(
  ws: WebSocket,
  msg: Record<string, unknown>,
  address: string,
  onHello?: (peer: ConnectedPeer) => void
): Promise<void> {
  const watchFolder = getSetting('watchFolder') ?? ''

  switch (msg.type) {
    case 'hello': {
      const peerId = msg.deviceId as string
      const existing = connectedPeers.get(peerId)
      if (existing && existing.ws !== ws) {
        if (existing.ws.readyState === WebSocket.OPEN) {
          // Already have a healthy connection — reject this duplicate instead of
          // closing the working one (closing it causes a disconnect → reconnect
          // → repeated file-list exchange → sync loop)
          console.log(`[Sync] duplicate connection from ${msg.deviceName}, rejecting new socket`)
          ws.close()
          break
        }
        // Existing connection is dead, replace it
        existing.ws.close()
      }
      const peer: ConnectedPeer = {
        ws,
        deviceId: peerId,
        deviceName: msg.deviceName as string,
        address
      }
      connectedPeers.set(peer.deviceId, peer)
      onHello?.(peer)
      console.log(`[Sync] peer connected: ${peer.deviceName} (${peer.address})`)
      syncEvents.emit('peer-connected', peer.deviceId, peer.deviceName)
      sendJSON(ws, { type: 'get-file-list' })
      break
    }

    case 'get-file-list': {
      if (!watchFolder) break
      const files = getFileList(watchFolder)
      sendJSON(ws, { type: 'file-list', files })
      break
    }

    case 'file-list': {
      if (!watchFolder) break
      const remoteFiles = msg.files as {
        path: string
        mtime: number
        size: number
      }[]
      const myFiles = getFileList(watchFolder)
      const myFileMap = new Map(myFiles.map((f) => [f.path, f]))

      for (const rf of remoteFiles) {
        const mine = myFileMap.get(rf.path)
        // Only request if remote is strictly newer (use 1000ms tolerance for
        // filesystem mtime precision differences between platforms)
        if (!mine || rf.mtime - mine.mtime > 1000) {
          sendJSON(ws, { type: 'request-file', path: rf.path })
        }
      }
      break
    }

    case 'request-file': {
      if (!watchFolder) break
      const rel = safeRelPath(watchFolder, msg.path as string)
      if (!rel) break
      const filePath = path.join(watchFolder, rel)

      try {
        const stat = fs.statSync(filePath)
        const data = fs.readFileSync(filePath)
        sendJSON(ws, {
          type: 'file-data',
          path: rel,
          mtime: stat.mtimeMs,
          data: data.toString('base64')
        })
      } catch {
        // file gone or unreadable
      }
      break
    }

    case 'file-data': {
      if (!watchFolder) break
      const rel = safeRelPath(watchFolder, msg.path as string)
      if (!rel) break
      const filePath = path.join(watchFolder, rel)
      const remoteMtime = msg.mtime as number

      // Skip if our local copy is already up-to-date (2s tolerance covers
      // HFS+ 1-second mtime precision and cross-platform rounding)
      try {
        const existing = fs.statSync(filePath)
        if (Math.abs(existing.mtimeMs - remoteMtime) <= 2000) break
      } catch {
        // file doesn't exist yet — proceed to write
      }

      try {
        fs.mkdirSync(path.dirname(filePath), { recursive: true })
        const buf = Buffer.from(msg.data as string, 'base64')
        fs.writeFileSync(filePath, buf)
        const mtimeSec = remoteMtime / 1000
        fs.utimesSync(filePath, mtimeSec, mtimeSec)

        // Read back actual mtime from disk — filesystem precision (e.g. HFS+
        // rounds to 1s) means what we read back may differ from remoteMtime.
        // markSyncWrite must use the real on-disk value so isSyncWrite matches.
        let actualMtime = remoteMtime
        try { actualMtime = fs.statSync(filePath).mtimeMs } catch { /* ignore */ }
        markSyncWrite(filePath, actualMtime)

        const sender = Array.from(connectedPeers.values()).find((p) => p.ws === ws)
        addSyncEvent(rel, 'received', sender?.deviceId, sender?.deviceName)
        syncEvents.emit('file-received', rel, sender?.deviceName)
      } catch {
        // write failed
      }
      break
    }

    case 'file-deleted': {
      if (!watchFolder) break
      const rel = safeRelPath(watchFolder, msg.path as string)
      if (!rel) break
      const filePath = path.join(watchFolder, rel)

      try {
        if (fs.existsSync(filePath)) {
          markSyncWrite(filePath, -1) // -1 = deletion sentinel
          fs.unlinkSync(filePath)
          const sender = Array.from(connectedPeers.values()).find((p) => p.ws === ws)
          addSyncEvent(rel, 'deleted', sender?.deviceId, sender?.deviceName)
          syncEvents.emit('file-deleted', rel)
        }
      } catch {
        // delete failed
      }
      break
    }
  }
}

export function startSyncServer(port: number): void {
  wss = new WebSocketServer({ port })

  wss.on('listening', () => {
    console.log(`[Sync] server listening on port ${port}`)
  })

  wss.on('connection', (ws, req) => {
    const address = req.socket.remoteAddress ?? 'unknown'
    let peer: ConnectedPeer | null = null
    console.log(`[Sync] inbound connection from ${address}`)

    sendJSON(ws, {
      type: 'hello',
      deviceId: myDeviceId,
      deviceName: getSetting('deviceName') ?? 'Unknown'
    })

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString()) as Record<string, unknown>
        handleMessage(ws, msg, address, (p) => {
          peer = p
        })
      } catch {
        // ignore malformed
      }
    })

    ws.on('close', () => {
      if (peer) {
        if (connectedPeers.get(peer.deviceId)?.ws === ws) {
          connectedPeers.delete(peer.deviceId)
          console.log(`[Sync] peer disconnected: ${peer.deviceName}`)
          syncEvents.emit('peer-disconnected', peer.deviceId)
        }
      }
    })

    ws.on('error', (err) => {
      console.error(`[Sync] inbound ws error from ${address}:`, err.message)
    })
  })

  wss.on('error', (err) => {
    console.error('[Sync] server error:', err.message)
  })
}

export function connectToPeer(
  deviceId: string,
  address: string,
  port: number
): void {
  if (connectedPeers.has(deviceId) || connectingPeers.has(deviceId)) return

  connectingPeers.add(deviceId)
  console.log(`[Sync] connecting to ${address}:${port}`)
  const ws = new WebSocket(`ws://${address}:${port}`)

  ws.on('open', () => {
    connectingPeers.delete(deviceId)
    console.log(`[Sync] connected to ${address}:${port}`)
    sendJSON(ws, {
      type: 'hello',
      deviceId: myDeviceId,
      deviceName: getSetting('deviceName') ?? 'Unknown'
    })
  })

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString()) as Record<string, unknown>
      handleMessage(ws, msg, address)
    } catch {
      // ignore malformed
    }
  })

  ws.on('close', () => {
    connectingPeers.delete(deviceId)
    if (connectedPeers.get(deviceId)?.ws === ws) {
      connectedPeers.delete(deviceId)
      syncEvents.emit('peer-disconnected', deviceId)
    }
  })

  ws.on('error', (err) => {
    console.error(`[Sync] connection error to ${address}:${port}:`, err.message)
    connectingPeers.delete(deviceId)
  })
}

export function broadcastFileChange(
  relativePath: string,
  watchFolder: string
): void {
  const filePath = path.join(watchFolder, relativePath)
  try {
    const data = fs.readFileSync(filePath)
    const stat = fs.statSync(filePath)
    const msg = {
      type: 'file-data',
      path: relativePath,
      mtime: stat.mtimeMs,
      data: data.toString('base64')
    }
    for (const peer of connectedPeers.values()) {
      sendJSON(peer.ws, msg)
    }
    addSyncEvent(relativePath, 'sent')
    syncEvents.emit('file-sent', relativePath)
  } catch {
    // file unreadable
  }
}

export function broadcastFileDeletion(relativePath: string): void {
  const msg = { type: 'file-deleted', path: relativePath }
  for (const peer of connectedPeers.values()) {
    sendJSON(peer.ws, msg)
  }
  addSyncEvent(relativePath, 'deleted-local')
}

export function getConnectedPeers(): {
  deviceId: string
  deviceName: string
  address: string
}[] {
  return Array.from(connectedPeers.values()).map((p) => ({
    deviceId: p.deviceId,
    deviceName: p.deviceName,
    address: p.address
  }))
}

export function stopSyncServer(): void {
  wss?.close()
}
