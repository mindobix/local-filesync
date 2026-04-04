import chokidar from 'chokidar'
import fs from 'fs'
import path from 'path'
import { broadcastFileChange, broadcastFileDeletion } from './sync'

let watcher: chokidar.FSWatcher | null = null

// Tracks files written by an incoming sync: normalized absolute path → mtime
// recorded from disk after write (or -1 for deletions).
// Suppression is mtime-based so it works regardless of file size / write duration.
const syncWrittenFiles = new Map<string, number>()

export function markSyncWrite(absolutePath: string, mtime: number): void {
  const key = path.resolve(absolutePath)
  syncWrittenFiles.set(key, mtime)
  // Safety-net cleanup — entry should be removed by isSyncWrite, but guard anyway
  setTimeout(() => syncWrittenFiles.delete(key), 30_000)
}

function isSyncWrite(filePath: string): boolean {
  const key = path.resolve(filePath)
  if (!syncWrittenFiles.has(key)) return false
  const expectedMtime = syncWrittenFiles.get(key)!

  // Deletion sentinel
  if (expectedMtime === -1) {
    syncWrittenFiles.delete(key)
    return true
  }

  try {
    const stat = fs.statSync(key)
    // 2s tolerance covers HFS+ 1-second precision and cross-platform rounding
    if (Math.abs(stat.mtimeMs - expectedMtime) <= 2000) {
      syncWrittenFiles.delete(key)
      return true
    }
  } catch {
    // file gone
  }

  // Mtime doesn't match — this is a genuine local change, let it through
  syncWrittenFiles.delete(key)
  return false
}

export function startWatcher(watchFolder: string): void {
  if (watcher) watcher.close()

  watcher = chokidar.watch(watchFolder, {
    ignoreInitial: true,
    ignored: /(^|[/\\])\../,
    persistent: true,
    awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 }
  })

  watcher.on('add', (filePath) => {
    if (isSyncWrite(filePath)) return
    broadcastFileChange(path.relative(watchFolder, filePath), watchFolder)
  })

  watcher.on('change', (filePath) => {
    if (isSyncWrite(filePath)) return
    broadcastFileChange(path.relative(watchFolder, filePath), watchFolder)
  })

  watcher.on('unlink', (filePath) => {
    if (isSyncWrite(filePath)) return
    broadcastFileDeletion(path.relative(watchFolder, filePath))
  })
}

export function stopWatcher(): void {
  watcher?.close()
  watcher = null
}
