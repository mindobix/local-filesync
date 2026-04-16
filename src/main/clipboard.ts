import { clipboard } from 'electron'
import fs from 'fs'
import path from 'path'
import { broadcastFileChange, CLIPBOARD_FILENAME } from './sync'

export type ClipboardPayload =
  | { type: 'text'; content: string; source: string; ts: number }
  | { type: 'image'; hash: string; source: string; ts: number } // stub — not yet implemented

let pollInterval: ReturnType<typeof setInterval> | null = null
// Last text value we either sent or received from a peer — used to break broadcast loops
let lastSyncedText = ''
let currentWatchFolder = ''
let deviceId = ''

export function setClipboardDeviceId(id: string): void {
  deviceId = id
}

/**
 * Called by the main process when a peer sends us a clipboard payload.
 * Applies the content to the local OS clipboard and updates the loop-guard
 * so the poller doesn't re-broadcast back to the sender.
 */
export function applyClipboardFromPeer(payload: ClipboardPayload): void {
  if (payload.source === deviceId) return // ignore our own echoed broadcasts

  if (payload.type === 'text') {
    lastSyncedText = payload.content
    clipboard.writeText(payload.content)
    console.log(`[Clipboard] applied text from peer (${payload.source.slice(0, 8)}…)`)
    return
  }

  // TODO: image support
  // if (payload.type === 'image') { ... }
}

/**
 * Start polling the OS clipboard every 500 ms.
 * Writes .filesync-clipboard.json to the watch folder and calls
 * broadcastFileChange directly (dot files are ignored by chokidar so the
 * watcher would never see it — we bypass it intentionally).
 */
export function startClipboardSync(folder: string): void {
  stopClipboardSync()
  if (!folder) return

  currentWatchFolder = folder
  // Seed with whatever is already on the clipboard so we don't broadcast on startup
  lastSyncedText = clipboard.readText()

  pollInterval = setInterval(() => {
    const text = clipboard.readText()

    // Nothing new — skip
    if (!text || text === lastSyncedText) return

    // Guard against enormous clipboard content (e.g. copying a whole SQL dump)
    if (text.length > 500_000) return

    lastSyncedText = text

    const payload: ClipboardPayload = {
      type: 'text',
      content: text,
      source: deviceId,
      ts: Date.now()
    }

    const filePath = path.join(currentWatchFolder, CLIPBOARD_FILENAME)
    try {
      fs.writeFileSync(filePath, JSON.stringify(payload), 'utf-8')
      // Bypass the watcher — dot files are ignored by chokidar, so push directly
      broadcastFileChange(CLIPBOARD_FILENAME, currentWatchFolder)
    } catch {
      // watch folder may not exist yet or write failed — silent fail
    }
  }, 500)

  console.log('[Clipboard] sync started')
}

export function stopClipboardSync(): void {
  if (pollInterval) {
    clearInterval(pollInterval)
    pollInterval = null
    console.log('[Clipboard] sync stopped')
  }
}
