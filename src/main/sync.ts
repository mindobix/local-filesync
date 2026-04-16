import WebSocket, { WebSocketServer } from 'ws'
import fs from 'fs'
import path from 'path'
import { EventEmitter } from 'events'
import { addSyncEvent, getSetting, recordTombstone, getTombstoneMap } from './db'
import { markSyncWrite } from './watcher'

export const syncEvents = new EventEmitter()

/** Wire-format filename used for clipboard sync. Dot-prefix keeps it hidden
 *  from the user's watch folder and ensures chokidar ignores it. */
export const CLIPBOARD_FILENAME = '.filesync-clipboard.json'

/** Files at or above this size use chunked transfer instead of a single message. */
const LARGE_FILE_THRESHOLD = 100 * 1024 * 1024 // 100 MB

/** Chunk size for large-file streaming (2 MB keeps memory bounded on both ends). */
const CHUNK_SIZE = 2 * 1024 * 1024 // 2 MB

interface ConnectedPeer {
  ws: WebSocket
  deviceId: string
  deviceName: string
  address: string
  paused: boolean
}

/** State tracked while receiving a large file in chunks. */
interface LargeFileTransfer {
  tmpPath: string      // dot-prefixed hidden temp file
  totalChunks: number
  receivedChunks: number
  mtime: number
}

let wss: WebSocketServer | null = null
const connectedPeers = new Map<string, ConnectedPeer>()
const connectingPeers = new Set<string>()
// Keyed by wire path. One in-progress receive per file at a time is sufficient
// because we only request each file from one peer.
const inProgressTransfers = new Map<string, LargeFileTransfer>()
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
  for (const peer of connectedPeers.values()) {
    sendJSON(peer.ws, { type: 'sync-state', paused })
  }
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
  const platformPath = requestedPath.split('/').join(path.sep)
  const rel = path.normalize(platformPath)
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null
  return rel
}

/** Temp file path for a large file receive — dot-prefixed so chokidar ignores it. */
function tmpPathFor(watchFolder: string, rel: string): string {
  const dir = path.dirname(path.join(watchFolder, rel))
  const base = path.basename(rel)
  return path.join(dir, `.${base}.filesync-tmp`)
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
        if (entry.name === CLIPBOARD_FILENAME) continue
        try {
          const stat = fs.statSync(full)
          // All file sizes are included — large files use the chunked transfer path.
          results.push({
            path: toWirePath(path.relative(watchFolder, full)),
            mtime: stat.mtimeMs,
            size: stat.size
          })
        } catch {
          // skip unreadable files
        }
      }
    }
  }

  scan(watchFolder)
  return results
}

/**
 * Stream a single large file to one peer in 2 MB chunks.
 * Reads the file incrementally so memory stays bounded regardless of file size.
 */
async function streamLargeFileToPeer(
  ws: WebSocket,
  wirePath: string,
  watchFolder: string
): Promise<void> {
  const rel = safeRelPath(watchFolder, wirePath)
  if (!rel) return
  const filePath = path.join(watchFolder, rel)

  let stat: fs.Stats
  try { stat = fs.statSync(filePath) } catch { return }

  const totalChunks = Math.ceil(stat.size / CHUNK_SIZE)
  console.log(`[Sync] streaming large file to peer: ${wirePath} (${(stat.size / 1024 / 1024).toFixed(1)} MB, ${totalChunks} chunks)`)

  sendJSON(ws, {
    type: 'large-file-start',
    path: wirePath,
    size: stat.size,
    mtime: stat.mtimeMs,
    totalChunks
  })

  try {
    const stream = fs.createReadStream(filePath, { highWaterMark: CHUNK_SIZE })
    let index = 0
    for await (const chunk of stream) {
      if (ws.readyState !== WebSocket.OPEN) break
      sendJSON(ws, {
        type: 'large-file-chunk',
        path: wirePath,
        index,
        data: (chunk as Buffer).toString('base64')
      })
      index++
    }
  } catch {
    // file became unreadable mid-stream — peer will time out waiting for large-file-end
    return
  }

  sendJSON(ws, { type: 'large-file-end', path: wirePath, mtime: stat.mtimeMs })
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
          console.log(`[Sync] duplicate connection from ${msg.deviceName}, rejecting new socket`)
          ws.close()
          break
        }
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
      const remoteSyncPort = typeof msg.syncPort === 'number' ? msg.syncPort as number : null
      syncEvents.emit('peer-connected', peer.deviceId, peer.deviceName, peer.address, remoteSyncPort)
      sendJSON(ws, { type: 'get-file-list' })
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
      const myTombstoneMap = getTombstoneMap()

      const sender = Array.from(connectedPeers.values()).find((p) => p.ws === ws)

      // 1. Apply remote tombstones
      for (const rt of remoteTombstones) {
        const existingTombstone = myTombstoneMap.get(rt.path)
        if (existingTombstone !== undefined) {
          if (rt.deletedAt > existingTombstone) {
            recordTombstone(rt.path, rt.deletedAt)
            myTombstoneMap.set(rt.path, rt.deletedAt)
          }
          continue
        }

        const localFile = myFileMap.get(rt.path)
        if (localFile && rt.deletedAt > localFile.mtime) {
          const localRel = safeRelPath(watchFolder, rt.path)
          if (localRel) {
            const filePath = path.join(watchFolder, localRel)
            try {
              if (fs.existsSync(filePath)) {
                markSyncWrite(filePath, -1)
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
          recordTombstone(rt.path, rt.deletedAt)
          myTombstoneMap.set(rt.path, rt.deletedAt)
        }
      }

      // 2. Request files that are newer on the remote
      for (const rf of remoteFiles) {
        const tombstoneTime = myTombstoneMap.get(rf.path)
        if (tombstoneTime !== undefined && tombstoneTime > rf.mtime) {
          sendJSON(ws, { type: 'file-deleted', path: rf.path, deletedAt: tombstoneTime })
          continue
        }

        const mine = myFileMap.get(rf.path)
        if (!mine || rf.mtime - mine.mtime > 1000) {
          // Route to the appropriate request type based on file size
          if (rf.size >= LARGE_FILE_THRESHOLD) {
            sendJSON(ws, { type: 'request-large-file', path: rf.path })
          } else {
            sendJSON(ws, { type: 'request-file', path: rf.path })
          }
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
        // Safety guard: if a peer requests a large file via the small-file path,
        // silently redirect to chunked transfer rather than loading it into memory.
        if (stat.size >= LARGE_FILE_THRESHOLD) {
          streamLargeFileToPeer(ws, toWirePath(rel), watchFolder).catch(() => {})
          break
        }
        const data = fs.readFileSync(filePath)
        sendJSON(ws, {
          type: 'file-data',
          path: toWirePath(rel),
          mtime: stat.mtimeMs,
          data: data.toString('base64')
        })
      } catch {
        // file gone or unreadable
      }
      break
    }

    // ── Large-file sender side ─────────────────────────────────────────────
    case 'request-large-file': {
      if (!watchFolder || syncPaused) break
      const wirePath = msg.path as string
      streamLargeFileToPeer(ws, wirePath, watchFolder).catch(() => {})
      break
    }

    // ── Large-file receiver side ───────────────────────────────────────────
    case 'large-file-start': {
      if (!watchFolder || syncPaused) break
      const wirePath = msg.path as string
      const rel = safeRelPath(watchFolder, wirePath)
      if (!rel) break

      const remoteMtime = msg.mtime as number

      // Skip if our local copy is already up-to-date
      try {
        const existing = fs.statSync(path.join(watchFolder, rel))
        if (Math.abs(existing.mtimeMs - remoteMtime) <= 2000) break
      } catch {
        // file doesn't exist yet — proceed
      }

      const tmpPath = tmpPathFor(watchFolder, rel)
      try {
        fs.mkdirSync(path.dirname(tmpPath), { recursive: true })
        // Remove any leftover temp file from a previous interrupted transfer
        try { fs.unlinkSync(tmpPath) } catch { /* didn't exist */ }
      } catch {
        break
      }

      inProgressTransfers.set(wirePath, {
        tmpPath,
        totalChunks: msg.totalChunks as number,
        receivedChunks: 0,
        mtime: remoteMtime
      })
      console.log(`[Sync] receiving large file: ${wirePath} (${msg.totalChunks} chunks)`)
      break
    }

    case 'large-file-chunk': {
      if (!watchFolder || syncPaused) break
      const wirePath = msg.path as string
      const transfer = inProgressTransfers.get(wirePath)
      if (!transfer) break // no matching start — ignore stale chunks

      try {
        const buf = Buffer.from(msg.data as string, 'base64')
        fs.appendFileSync(transfer.tmpPath, buf)
        transfer.receivedChunks++
      } catch {
        // write failed — abandon this transfer
        inProgressTransfers.delete(wirePath)
      }
      break
    }

    case 'large-file-end': {
      if (!watchFolder || syncPaused) break
      const wirePath = msg.path as string
      const transfer = inProgressTransfers.get(wirePath)
      if (!transfer) break

      inProgressTransfers.delete(wirePath)

      const rel = safeRelPath(watchFolder, wirePath)
      if (!rel) {
        try { fs.unlinkSync(transfer.tmpPath) } catch { /* ignore */ }
        break
      }

      const finalPath = path.join(watchFolder, rel)
      const remoteMtime = (msg.mtime as number | undefined) ?? transfer.mtime

      try {
        fs.mkdirSync(path.dirname(finalPath), { recursive: true })
        fs.renameSync(transfer.tmpPath, finalPath)
        const mtimeSec = remoteMtime / 1000
        fs.utimesSync(finalPath, mtimeSec, mtimeSec)

        let actualMtime = remoteMtime
        try { actualMtime = fs.statSync(finalPath).mtimeMs } catch { /* ignore */ }
        markSyncWrite(finalPath, actualMtime)

        const sender = Array.from(connectedPeers.values()).find((p) => p.ws === ws)
        addSyncEvent(wirePath, 'received', sender?.deviceId, sender?.deviceName)
        syncEvents.emit('file-received', wirePath, sender?.deviceName)
        console.log(`[Sync] large file complete: ${wirePath} (${transfer.receivedChunks}/${transfer.totalChunks} chunks)`)
      } catch {
        // rename failed — clean up temp
        try { fs.unlinkSync(transfer.tmpPath) } catch { /* ignore */ }
      }
      break
    }

    // ── Small-file receiver ────────────────────────────────────────────────
    case 'file-data': {
      if (!watchFolder || syncPaused) break
      const wirePath = msg.path as string

      // Clipboard file — apply to OS clipboard and skip normal file handling
      if (wirePath === CLIPBOARD_FILENAME) {
        try {
          const json = Buffer.from(msg.data as string, 'base64').toString('utf-8')
          const payload = JSON.parse(json) as Record<string, unknown>
          syncEvents.emit('clipboard-received', payload)
        } catch {
          // malformed payload — ignore
        }
        break
      }

      const rel = safeRelPath(watchFolder, wirePath)
      if (!rel) break
      const filePath = path.join(watchFolder, rel)
      const remoteMtime = msg.mtime as number

      // Reject if we have a tombstone that is newer than this file version
      const tombstoneTime = getTombstoneMap().get(wirePath)
      if (tombstoneTime !== undefined && tombstoneTime > remoteMtime) {
        sendJSON(ws, { type: 'file-deleted', path: wirePath, deletedAt: tombstoneTime })
        break
      }

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

      try {
        const stat = fs.statSync(filePath)
        if (stat.mtimeMs > deletedAt) break
      } catch {
        // file doesn't exist — still record the tombstone below
      }

      try {
        if (fs.existsSync(filePath)) {
          markSyncWrite(filePath, -1)
          fs.unlinkSync(filePath)
          removeEmptyParents(filePath, watchFolder)
        }
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
  const wirePath = toWirePath(relativePath)

  try {
    const stat = fs.statSync(filePath)

    // Large files use chunked streaming to avoid loading the whole file into memory
    if (stat.size >= LARGE_FILE_THRESHOLD) {
      const peers = Array.from(connectedPeers.values())
      if (peers.length === 0) return
      console.log(`[Sync] broadcasting large file: ${wirePath} (${(stat.size / 1024 / 1024).toFixed(1)} MB)`)
      // Stream to all peers concurrently — each peer gets its own read stream
      for (const peer of peers) {
        streamLargeFileToPeer(peer.ws, wirePath, watchFolder).catch(() => {})
      }
      addSyncEvent(wirePath, 'sent')
      syncEvents.emit('file-sent', wirePath)
      return
    }

    const data = fs.readFileSync(filePath)
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
 */
export function requestSyncFromPeer(deviceId: string): void {
  const peer = connectedPeers.get(deviceId)
  if (peer && peer.ws.readyState === WebSocket.OPEN) {
    console.log(`[Sync] requesting file list from ${peer.deviceName} for catch-up sync`)
    sendJSON(peer.ws, { type: 'get-file-list' })
  }
}
