import chokidar from 'chokidar'
import path from 'path'
import { broadcastFileChange, broadcastFileDeletion } from './sync'

let watcher: chokidar.FSWatcher | null = null

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
    const rel = path.relative(watchFolder, filePath)
    broadcastFileChange(rel, watchFolder)
  })

  watcher.on('change', (filePath) => {
    const rel = path.relative(watchFolder, filePath)
    broadcastFileChange(rel, watchFolder)
  })

  watcher.on('unlink', (filePath) => {
    const rel = path.relative(watchFolder, filePath)
    broadcastFileDeletion(rel)
  })
}

export function stopWatcher(): void {
  watcher?.close()
  watcher = null
}
