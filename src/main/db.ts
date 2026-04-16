import { app } from 'electron'
import path from 'path'
import fs from 'fs'
import os from 'os'

interface Tombstone {
  path: string      // wire-format (forward slashes)
  deletedAt: number // ms timestamp
}

interface DbData {
  settings: Record<string, string>
  peers: PeerRow[]
  syncEvents: SyncEventRow[]
  nextEventId: number
  tombstones: Tombstone[]
}

interface PeerRow {
  id: string
  name: string
  address: string
  port: number
  last_seen: number
}

interface SyncEventRow {
  id: number
  file_path: string
  event_type: string
  peer_id: string | null
  peer_name: string | null
  timestamp: number
}

let dbPath = ''
let data: DbData = {
  settings: {},
  peers: [],
  syncEvents: [],
  nextEventId: 1,
  tombstones: []
}

function load(): void {
  try {
    const raw = fs.readFileSync(dbPath, 'utf-8')
    data = JSON.parse(raw)
    // Migrate: older db files won't have tombstones
    if (!data.tombstones) data.tombstones = []
  } catch {
    // file doesn't exist yet or is corrupt — start fresh
    data = { settings: {}, peers: [], syncEvents: [], nextEventId: 1, tombstones: [] }
  }
}

function save(): void {
  try {
    fs.writeFileSync(dbPath, JSON.stringify(data, null, 2), 'utf-8')
  } catch (err) {
    console.error('[db] save failed:', err)
  }
}

export function initDB(): void {
  dbPath = path.join(app.getPath('userData'), 'filesync.json')
  load()

  // Set defaults if missing
  const defaults: Record<string, string> = {
    watchFolder: '',
    deviceName: os.hostname(),
    syncPort: '9876',
    autoLaunch: 'false'
  }
  let changed = false
  for (const [k, v] of Object.entries(defaults)) {
    if (!(k in data.settings)) {
      data.settings[k] = v
      changed = true
    }
  }

  // Drop tombstones older than 30 days to keep the db compact
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000
  const before = data.tombstones.length
  data.tombstones = data.tombstones.filter((t) => t.deletedAt > cutoff)
  if (changed || data.tombstones.length !== before) save()
}

export function getSetting(key: string): string | null {
  return data.settings[key] ?? null
}

export function setSetting(key: string, value: string): void {
  data.settings[key] = value
  save()
}

export function getSettings(): Record<string, string> {
  return { ...data.settings }
}

export function upsertPeer(id: string, name: string, address: string, port: number): void {
  const idx = data.peers.findIndex((p) => p.id === id)
  const row: PeerRow = { id, name, address, port, last_seen: Date.now() }
  if (idx >= 0) {
    data.peers[idx] = row
  } else {
    data.peers.push(row)
  }
  save()
}

export function getPeers(): PeerRow[] {
  return [...data.peers].sort((a, b) => b.last_seen - a.last_seen)
}

export function addSyncEvent(
  filePath: string,
  eventType: string,
  peerId?: string,
  peerName?: string
): void {
  data.syncEvents.unshift({
    id: data.nextEventId++,
    file_path: filePath,
    event_type: eventType,
    peer_id: peerId ?? null,
    peer_name: peerName ?? null,
    timestamp: Date.now()
  })
  // Keep only last 500 events
  if (data.syncEvents.length > 500) {
    data.syncEvents.length = 500
  }
  save()
}

export function getSyncEvents(limit = 100): SyncEventRow[] {
  return data.syncEvents.slice(0, limit)
}

// Record (or update) a deletion tombstone. Uses the most-recent deletedAt if called
// multiple times for the same path.
export function recordTombstone(wirePath: string, deletedAt = Date.now()): void {
  const idx = data.tombstones.findIndex((t) => t.path === wirePath)
  if (idx >= 0) {
    if (deletedAt > data.tombstones[idx].deletedAt) {
      data.tombstones[idx].deletedAt = deletedAt
    }
  } else {
    data.tombstones.push({ path: wirePath, deletedAt })
  }
  save()
}

// Returns a Map of wirePath → deletedAt for fast lookup.
export function getTombstoneMap(): Map<string, number> {
  return new Map(data.tombstones.map((t) => [t.path, t.deletedAt]))
}
