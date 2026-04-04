# local-filesync

**Zero-config LAN file sync for developers working across Windows, macOS, and Linux.**

No cloud. No accounts. No subscriptions. Drop files in a folder — every device on your network gets them instantly.

---

## Why local-filesync?

You're working across machines. You save a config file on your Mac, need it on your Windows dev box, and your Linux server. You're tired of:

- Emailing files to yourself
- Fighting Dropbox/OneDrive sync conflicts
- Setting up SSH or SMB shares
- Waiting for cloud roundtrips on your own LAN

local-filesync runs as a lightweight system tray app on all your machines. Point it at a folder. Everything stays in sync — automatically, instantly, offline.

---

## Features

### Automatic peer discovery
Devices on the same LAN find each other without any configuration. Open the app, pick a folder, done. No IP addresses to type, no server to set up.

### Real-time file sync
Changes are detected the moment you save a file and pushed to all connected peers immediately over WebSocket. Supports files up to 100 MB.

### Full folder structure sync
Subfolders and nested directory trees sync correctly across all platforms. A folder created on Windows appears as a proper folder on Mac and Linux — not a mangled filename.

### Bidirectional sync
Every connected device is both a sender and receiver. Save on any machine, get it on every other.

### Deletion sync
Delete a file on one device, it's removed everywhere.

### Manual connect
Auto-discovery blocked by your router or VPN? Enter an IP and port directly to connect to any peer.

### Live activity log
Dashboard shows a real-time stream of every file sent, received, deleted, and every peer connect/disconnect — with timestamps.

### Persistent event history
Last 500 sync events are stored locally so you can see what synced while you were away.

### Catch-up sync on reconnect
When a peer comes back online after being offline, it automatically pulls any files it missed. A periodic catch-up runs every 5 minutes as a safety net.

### System tray
Runs quietly in the background. No dock icon needed. Click the tray icon to open the UI.

### Launch at login
Optional auto-start so your sync is always running.

### Configurable device name and port
Name your devices anything you want. Change the sync port if 9876 conflicts with something else — just keep it consistent across devices.

---

## Supported platforms

| Platform | Build command | Notes |
|---|---|---|
| macOS (Apple Silicon) | `npm run dist:mac` | arm64 DMG |
| macOS 15 Sequoia (Universal) | `npm run dist:mac15` | arm64 + x64, grants local network permission |
| Windows | `npm run dist:win` | x64 NSIS installer |
| Linux | `npm run dist:linux` | x64 AppImage |

---

## Getting started

### Prerequisites

- [Node.js](https://nodejs.org) 18+
- macOS: Xcode Command Line Tools (`xcode-select --install`)
- Windows: Nothing extra needed

### Install and run

```bash
git clone https://github.com/mindobix/local-filesync.git
cd local-filesync
npm install
```

### Development

```bash
npm run dev
```

### Build for distribution

```bash
# macOS (Apple Silicon)
npm run dist:mac

# macOS 15 Sequoia — grants local network access permission prompt
npm run dist:mac15

# Windows
npm run dist:win

# Linux
npm run dist:linux
```

---

## How it works

```
┌──────────────────────────────────────────────────────────┐
│                        Your LAN                          │
│                                                          │
│  ┌─────────────┐   UDP broadcast    ┌─────────────────┐  │
│  │   Mac       │ ◄────────────────► │   Windows PC    │  │
│  │             │                    │                 │  │
│  │  /sync ─────┼────── WebSocket ───┼──► C:\sync      │  │
│  └─────────────┘    file transfer   └─────────────────┘  │
│                                                          │
│              ┌─────────────────┐                         │
│              │   Linux server  │                         │
│              │  ~/sync ◄───────┼─────────────────────    │
│              └─────────────────┘                         │
└──────────────────────────────────────────────────────────┘
```

1. **Discovery** — each app broadcasts a UDP packet every 5 seconds on your LAN. Peers appear automatically within seconds.
2. **Connection** — peers connect over WebSocket (port 9876 by default). No relay server, direct device-to-device.
3. **Sync** — on connect, devices exchange file lists and pull anything newer from the other side. From then on, changes are pushed in real time as files are saved.
4. **Loop prevention** — incoming files are tracked by path and mtime. The file watcher ignores writes made by sync itself, so files don't bounce back and forth.

---

## Tech stack

- **Electron** — cross-platform desktop shell
- **electron-vite** — fast build tooling
- **React + Tailwind CSS** — UI
- **ws** — WebSocket server/client for file transfer
- **chokidar** — file system watcher
- **UDP broadcast** — zero-config peer discovery
- **JSON file store** — lightweight local persistence, no database binary required

---

## Configuration

All settings are saved per-device and persist across restarts.

| Setting | Default | Description |
|---|---|---|
| Watch Folder | _(none)_ | The folder to sync. Set this first. |
| Device Name | System hostname | How this device appears to peers. |
| Sync Port | `9876` | WebSocket port. Must match on all devices. |
| Launch at login | Off | Start automatically on system login. |

Settings are stored in your OS user data directory (`app.getPath('userData')`).

---

## Network requirements

- All devices must be on the **same LAN** (same router/switch).
- UDP port **9877** must be open for peer discovery (broadcast).
- TCP port **9876** (or your configured port) must be open for file transfer.
- Works on home networks out of the box. Corporate/managed networks may require firewall rules.

---

## macOS 15 note

macOS 15 Sequoia requires explicit permission for apps to access the local network. The `dist:mac15` build includes the required `NSLocalNetworkUsageDescription` plist entry. On first launch, macOS will show a permission prompt — click **Allow**. Without this, peer discovery and connections are silently blocked by the OS.

---

## License

MIT
