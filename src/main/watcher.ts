import chokidar from 'chokidar'
import path from 'path'
import { broadcastFileChange, broadcastFileDeletion } from './sync'

let watcher: chokidar.FSWatcher | null = null

// Paths currently being written by an incoming sync — watcher must ignore these
const syncWriting = new Set<string>()

export function markSyncWrite(absolutePath: string, durationMs = 2000): void {
  syncWriting.add(absolutePath)
  setTimeout(() => syncWriting.delete(absolutePath), durationMs)
}

export function startWatcher(watchFolder: string): void {
  if (watcher) {
    watcher.close()
  }

  watcher = chokidar.watch(watchFolder, {
    ignoreInitial: true,
    ignored: /(^|[/\\])\../,
    persistent: true,
    awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 }
  })

  watcher.on('add', (filePath) => {
    if (syncWriting.has(filePath)) return
    const rel = path.relative(watchFolder, filePath)
    broadcastFileChange(rel, watchFolder)
  })

  watcher.on('change', (filePath) => {
    if (syncWriting.has(filePath)) return
    const rel = path.relative(watchFolder, filePath)
    broadcastFileChange(rel, watchFolder)
  })

  watcher.on('unlink', (filePath) => {
    if (syncWriting.has(filePath)) return
    const rel = path.relative(watchFolder, filePath)
    broadcastFileDeletion(rel)
  })
}

export function stopWatcher(): void {
  watcher?.close()
  watcher = null
}
