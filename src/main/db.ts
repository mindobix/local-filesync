import Database from 'better-sqlite3'
import { app } from 'electron'
import path from 'path'
import os from 'os'

let db: Database.Database

export function initDB(): Database.Database {
  const dbPath = path.join(app.getPath('userData'), 'filesync.db')
  db = new Database(dbPath)

  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS peers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      address TEXT,
      port INTEGER,
      last_seen INTEGER
    );

    CREATE TABLE IF NOT EXISTS sync_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_path TEXT NOT NULL,
      event_type TEXT NOT NULL,
      peer_id TEXT,
      peer_name TEXT,
      timestamp INTEGER NOT NULL
    );
  `)

  const insertDefault = db.prepare(
    `INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)`
  )
  insertDefault.run('watchFolder', '')
  insertDefault.run('deviceName', os.hostname())
  insertDefault.run('syncPort', '9876')
  insertDefault.run('autoLaunch', 'false')

  return db
}

export function getSetting(key: string): string | null {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined
  return row ? row.value : null
}

export function setSetting(key: string, value: string): void {
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(
    key,
    value
  )
}

export function getSettings(): Record<string, string> {
  const rows = db
    .prepare('SELECT key, value FROM settings')
    .all() as { key: string; value: string }[]
  return rows.reduce(
    (acc, row) => {
      acc[row.key] = row.value
      return acc
    },
    {} as Record<string, string>
  )
}

export function upsertPeer(
  id: string,
  name: string,
  address: string,
  port: number
): void {
  db.prepare(
    `INSERT OR REPLACE INTO peers (id, name, address, port, last_seen) VALUES (?, ?, ?, ?, ?)`
  ).run(id, name, address, port, Date.now())
}

export function getPeers(): unknown[] {
  return db
    .prepare('SELECT * FROM peers ORDER BY last_seen DESC')
    .all()
}

export function addSyncEvent(
  filePath: string,
  eventType: string,
  peerId?: string,
  peerName?: string
): void {
  db.prepare(
    `INSERT INTO sync_events (file_path, event_type, peer_id, peer_name, timestamp) VALUES (?, ?, ?, ?, ?)`
  ).run(filePath, eventType, peerId ?? null, peerName ?? null, Date.now())
}

export function getSyncEvents(limit = 100): unknown[] {
  return db
    .prepare('SELECT * FROM sync_events ORDER BY timestamp DESC LIMIT ?')
    .all(limit)
}
