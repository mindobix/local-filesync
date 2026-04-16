import WebSocket, { WebSocketServer } from 'ws'
import fs from 'fs'
import path from 'path'
import { EventEmitter } from 'events'
import { addSyncEvent, getSetting, recordTombstone, getTombstoneMap } from './db'
import { markSyncWrite } from './watcher'

export const syncEvents = new EventEmitter()

interface ConnectedPeer {
  ws: WebSocket
  deviceId: string
  deviceName: string
  address: string
  paused: boolean
}

let wss: WebSocketServer | null = null
const connectedPeers = new Map<string, ConnectedPeer>()
const connectingPeers = new Set<string>()
let myDeviceId = ''
let syncPaused = false

export function setMyDeviceId(id: string): void {
  myDeviceId = id
}

export function isSyncPaused(): boolean {
  return syncPaused
}

export function setSyncPaused(paused: boolean): void {
  syncPaused = paused
  // Tell every connected peer about the new state
  for (const peer of connectedPeers.values()) {
    sendJSON(peer.ws, { type: 'sync-state', paused })
  }
  // On resume, ask all peers for their latest file list so we catch up immediately
  if (!paused) {
    for (const peer of connectedPeers.values()) {
      sendJSON(peer.ws, { type: 'get-file-list' })
    }
  }
  syncEvents.emit('sync-paused-changed', paused)
}

function sendJSON(ws: WebSocket, data: unknown): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data))
  }
}

// Convert a platform-specific relative path to the wire format (always forward slashes).
function toWirePath(relPath: string): string {
  return relPath.split(path.sep).join('/')
}

// Remove empty ancestor directories up to (but not including) watchFolder after a
// file deletion, so that deleting the last file in a folder also removes the folder.
function removeEmptyParents(filePath: string, watchFolder: string): void {
  let dir = path.dirname(filePath)
  while (dir.length > watchFolder.length && dir.startsWith(watchFolder)) {
    try {
      const entries = fs.readdirSync(dir)
      if (entries.length === 0) {
        fs.rmdirSync(dir)
        dir = path.dirname(dir)
      } else {
        break
      }
    } catch {
      break
    }
  }
}

// Convert a wire-format path (forward slashes) to a safe local relative path.
// Returns null if the path is malicious (traversal or absolute).
function safeRelPath(
  _watchFolder: string,
  requestedPath: string
): string | null {
  // Wire paths always use forward slashes; convert to the local separator before
  // normalizing so that path.normalize can detect traversal correctly on all OSes.
  const platformPath = requestedPath.split('/').join(path.sep)
  const rel = path.normalize(platformPath)
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
              // Always use forward slashes on the wire so Windows and macOS/Linux
              // paths compare correctly in the file-list map lookup.
              path: toWirePath(path.relative(watchFolder, full)),
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
        address,
        paused: false
      }
      connectedPeers.set(peer.deviceId, peer)
      onHello?.(peer)
      console.log(`[Sync] peer connected: ${peer.deviceName} (${peer.address})`)
      // Emit syncPort so the main process can persist this peer for reconnection
      const remoteSyncPort = typeof msg.syncPort === 'number' ? msg.syncPort as number : null
      syncEvents.emit('peer-connected', peer.deviceId, peer.deviceName, peer.address, remoteSyncPort)
      sendJSON(ws, { type: 'get-file-list' })
      // Immediately share our pause state so the new peer knows whether we're active
      sendJSON(ws, { type: 'sync-state', paused: syncPaused })
      break
    }

    case 'sync-state': {
      const remPaused = msg.paused as boolean
      for (const p of connectedPeers.values()) {
        if (p.ws === ws) {
          p.paused = remPaused
          syncEvents.emit('peer-sync-state', p.deviceId, p.deviceName, remPaused)
          break
        }
      }
      break
    }

    case 'get-file-list': {
      if (!watchFolder || syncPaused) break
      const files = getFileList(watchFolder)
      // Include our tombstones so the peer can apply any deletions it missed while offline
      const tombstones = Array.from(getTombstoneMap().entries()).map(([p, deletedAt]) => ({
        path: p,
        deletedAt
      }))
      sendJSON(ws, { type: 'file-list', files, tombstones })
      break
    }

    case 'file-list': {
      if (!watchFolder || syncPaused) break
      const remoteFiles = (msg.files as { path: string; mtime: number; size: number }[]) ?? []
      const remoteTombstones = (
        (msg.tombstones as { path: string; deletedAt: number }[]) ?? []
      )

      const myFiles = getFileList(watchFolder)
      const myFileMap = new Map(myFiles.map((f) => [f.path, f]))
      // Work with a mutable copy so tombstone application is reflected immediately
      const myTombstoneMap = getTombstoneMap()

      const sender = Array.from(connectedPeers.values()).find((p) => p.ws === ws)

      // 1. Apply remote tombstones: delete local files that the peer deleted more recently
      for (const rt of remoteTombstones) {
        const existingTombstone = myTombstoneMap.get(rt.path)
        if (existingTombstone !== undefined) {
          // Already tombstoned locally — keep the newer timestamp
          if (rt.deletedAt > existingTombstone) {
            recordTombstone(rt.path, rt.deletedAt)
            myTombstoneMap.set(rt.path, rt.deletedAt)
          }
          continue
        }

        const localFile = myFileMap.get(rt.path)
        if (localFile && rt.deletedAt > localFile.mtime) {
          // Remote deletion is newer than our local copy — delete it
          const localRel = safeRelPath(watchFolder, rt.path)
          if (localRel) {
            const filePath = path.join(watchFolder, localRel)
            try {
              if (fs.existsSync(filePath)) {
                markSyncWrite(filePath)
                fs.unlinkSync(filePath)
                removeEmptyParents(filePath, watchFolder)
              }
              recordTombstone(rt.path, rt.deletedAt)
              myTombstoneMap.set(rt.path, rt.deletedAt)
              myFileMap.delete(rt.path)
              addSyncEvent(rt.path, 'deleted', sender?.deviceId, sender?.deviceName)
              syncEvents.emit('file-deleted', rt.path)
            } catch {
              // skip unreadable
            }
          }
        } else if (!localFile) {
          // We don't have the file either — just persist the tombstone so future
          // reconnects don't re-request it
          recordTombstone(rt.path, rt.deletedAt)
          myTombstoneMap.set(rt.path, rt.deletedAt)
        }
        // If localFile exists and is newer than the tombstone, our version wins — ignore
      }

      // 2. Process remote file list against our updated tombstones
      for (const rf of remoteFiles) {
        const tombstoneTime = myTombstoneMap.get(rf.path)
        if (tombstoneTime !== undefined && tombstoneTime > rf.mtime) {
          // We deleted this file more recently than the remote's last modification —
          // tell the peer to delete their copy too
          sendJSON(ws, { type: 'file-deleted', path: rf.path, deletedAt: tombstoneTime })
          continue
        }

        const mine = myFileMap.get(rf.path)
        // Only request if remote is strictly newer (1 s tolerance for mtime precision)
        if (!mine || rf.mtime - mine.mtime > 1000) {
          sendJSON(ws, { type: 'request-file', path: rf.path })
        }
      }
      break
    }

    case 'request-file': {
      if (!watchFolder || syncPaused) break
      const rel = safeRelPath(watchFolder, msg.path as string)
      if (!rel) break
      const filePath = path.join(watchFolder, rel)

      try {
        const stat = fs.statSync(filePath)
        const data = fs.readFileSync(filePath)
        sendJSON(ws, {
          type: 'file-data',
          // Reply with wire format (forward slashes) so any OS can receive correctly.
          path: toWirePath(rel),
          mtime: stat.mtimeMs,
          data: data.toString('base64')
        })
      } catch {
        // file gone or unreadable
      }
      break
    }

    case 'file-data': {
      if (!watchFolder || syncPaused) break
      const wirePath = msg.path as string
      const rel = safeRelPath(watchFolder, wirePath)
      if (!rel) break
      const filePath = path.join(watchFolder, rel)
      const remoteMtime = msg.mtime as number

      // Reject if we have a tombstone that is newer than this file version
      const tombstoneTime = getTombstoneMap().get(wirePath)
      if (tombstoneTime !== undefined && tombstoneTime > remoteMtime) {
        // Inform the sender so they also delete their copy
        sendJSON(ws, { type: 'file-deleted', path: wirePath, deletedAt: tombstoneTime })
        break
      }

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
        addSyncEvent(wirePath, 'received', sender?.deviceId, sender?.deviceName)
        syncEvents.emit('file-received', wirePath, sender?.deviceName)
      } catch {
        // write failed
      }
      break
    }

    case 'file-deleted': {
      if (!watchFolder || syncPaused) break
      const wirePath = msg.path as string
      const deletedAt = (msg.deletedAt as number | undefined) ?? Date.now()
      const rel = safeRelPath(watchFolder, wirePath)
      if (!rel) break
      const filePath = path.join(watchFolder, rel)

      // If our local file was modified after the reported deletion, our version wins
      try {
        const stat = fs.statSync(filePath)
        if (stat.mtimeMs > deletedAt) break
      } catch {
        // file doesn't exist — still record the tombstone below
      }

      try {
        if (fs.existsSync(filePath)) {
          markSyncWrite(filePath, -1) // -1 = deletion sentinel
          fs.unlinkSync(filePath)
          removeEmptyParents(filePath, watchFolder)
        }
        // Persist tombstone even if file was already absent so it survives reconnects
        recordTombstone(wirePath, deletedAt)
        const sender = Array.from(connectedPeers.values()).find((p) => p.ws === ws)
        addSyncEvent(wirePath, 'deleted', sender?.deviceId, sender?.deviceName)
        syncEvents.emit('file-deleted', wirePath)
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
      deviceName: getSetting('deviceName') ?? 'Unknown',
      syncPort: parseInt(getSetting('syncPort') ?? '9876', 10)
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
      deviceName: getSetting('deviceName') ?? 'Unknown',
      syncPort: parseInt(getSetting('syncPort') ?? '9876', 10)
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
  if (syncPaused) return
  const filePath = path.join(watchFolder, relativePath)
  // Normalize to wire format so the receiver (any OS) gets consistent forward slashes.
  const wirePath = toWirePath(relativePath)
  try {
    const data = fs.readFileSync(filePath)
    const stat = fs.statSync(filePath)
    const msg = {
      type: 'file-data',
      path: wirePath,
      mtime: stat.mtimeMs,
      data: data.toString('base64')
    }
    for (const peer of connectedPeers.values()) {
      sendJSON(peer.ws, msg)
    }
    addSyncEvent(wirePath, 'sent')
    syncEvents.emit('file-sent', wirePath)
  } catch {
    // file unreadable
  }
}

export function broadcastFileDeletion(relativePath: string): void {
  if (syncPaused) return
  const wirePath = toWirePath(relativePath)
  const deletedAt = Date.now()
  // Persist tombstone before broadcasting so reconnecting peers see it in file-list
  recordTombstone(wirePath, deletedAt)
  const msg = { type: 'file-deleted', path: wirePath, deletedAt }
  for (const peer of connectedPeers.values()) {
    sendJSON(peer.ws, msg)
  }
  addSyncEvent(wirePath, 'deleted-local')
}

export function getConnectedPeers(): {
  deviceId: string
  deviceName: string
  address: string
  paused: boolean
}[] {
  return Array.from(connectedPeers.values()).map((p) => ({
    deviceId: p.deviceId,
    deviceName: p.deviceName,
    address: p.address,
    paused: p.paused
  }))
}

export function stopSyncServer(): void {
  wss?.close()
}

/**
 * Ask a specific peer to send us their file list so we can pull anything
 * we're missing or that's newer on their side.
 * Safe to call at any time — it's a pure pull request, no files are pushed.
 */
export function requestSyncFromPeer(deviceId: string): void {
  const peer = connectedPeers.get(deviceId)
  if (peer && peer.ws.readyState === WebSocket.OPEN) {
    console.log(`[Sync] requesting file list from ${peer.deviceName} for catch-up sync`)
    sendJSON(peer.ws, { type: 'get-file-list' })
  }
}
