import WebSocket, { WebSocketServer } from 'ws'
import fs from 'fs'
import path from 'path'
import { EventEmitter } from 'events'
import { addSyncEvent, getSetting } from './db'

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
      const peer: ConnectedPeer = {
        ws,
        deviceId: msg.deviceId as string,
        deviceName: msg.deviceName as string,
        address
      }
      connectedPeers.set(peer.deviceId, peer)
      onHello?.(peer)
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
        if (!mine || mine.mtime < rf.mtime) {
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

      try {
        fs.mkdirSync(path.dirname(filePath), { recursive: true })
        const buf = Buffer.from(msg.data as string, 'base64')
        fs.writeFileSync(filePath, buf)
        const mtimeSec = (msg.mtime as number) / 1000
        fs.utimesSync(filePath, mtimeSec, mtimeSec)

        const sender = Array.from(connectedPeers.values()).find(
          (p) => p.ws === ws
        )
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
          fs.unlinkSync(filePath)
          const sender = Array.from(connectedPeers.values()).find(
            (p) => p.ws === ws
          )
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

  wss.on('connection', (ws, req) => {
    const address = req.socket.remoteAddress ?? 'unknown'
    let peer: ConnectedPeer | null = null

    // Send our hello first
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
        connectedPeers.delete(peer.deviceId)
        syncEvents.emit('peer-disconnected', peer.deviceId)
      }
    })

    ws.on('error', () => {/* ignore */})
  })

  wss.on('error', () => {/* ignore port conflicts */})
}

export function connectToPeer(
  deviceId: string,
  address: string,
  port: number
): void {
  if (connectedPeers.has(deviceId) || connectingPeers.has(deviceId)) return

  connectingPeers.add(deviceId)
  const ws = new WebSocket(`ws://${address}:${port}`)

  ws.on('open', () => {
    connectingPeers.delete(deviceId)
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
    connectedPeers.delete(deviceId)
    syncEvents.emit('peer-disconnected', deviceId)
  })

  ws.on('error', () => {
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
