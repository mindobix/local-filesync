import dgram from 'dgram'
import { EventEmitter } from 'events'
import os from 'os'

const DISCOVERY_PORT = 9877
const BROADCAST_INTERVAL = 5000
const PEER_STALE_MS = 30_000

export interface PeerInfo {
  deviceId: string
  deviceName: string
  address: string
  syncPort: number
  lastSeen: number
}

export const discoveryEvents = new EventEmitter()

let socket: dgram.Socket | null = null
let broadcastInterval: NodeJS.Timeout | null = null
const knownPeers = new Map<string, PeerInfo>()

export function startDiscovery(
  deviceId: string,
  deviceName: string,
  syncPort: number
): void {
  socket = dgram.createSocket({ type: 'udp4', reuseAddr: true })

  socket.on('error', () => {/* ignore bind/send errors */})

  socket.on('message', (msg, rinfo) => {
    try {
      const data = JSON.parse(msg.toString())
      if (data.type === 'filesync-hello' && data.deviceId !== deviceId) {
        const peer: PeerInfo = {
          deviceId: data.deviceId,
          deviceName: data.deviceName,
          address: rinfo.address,
          syncPort: data.syncPort,
          lastSeen: Date.now()
        }
        const isNew = !knownPeers.has(peer.deviceId)
        knownPeers.set(peer.deviceId, peer)
        discoveryEvents.emit('peer', peer, isNew)
      }
    } catch {
      // ignore malformed packets
    }
  })

  socket.bind(DISCOVERY_PORT, () => {
    socket?.setBroadcast(true)
    announce()
  })

  const getBroadcastAddresses = (): string[] => {
    const addrs: string[] = []
    for (const iface of Object.values(os.networkInterfaces())) {
      if (!iface) continue
      for (const addr of iface) {
        if (addr.family === 'IPv4' && !addr.internal) {
          const ip = addr.address.split('.').map(Number)
          const mask = addr.netmask.split('.').map(Number)
          const broadcast = ip.map((b, i) => (b | (~mask[i] & 0xff)) & 0xff).join('.')
          addrs.push(broadcast)
        }
      }
    }
    return addrs.length > 0 ? addrs : ['255.255.255.255']
  }

  const announce = () => {
    const payload = Buffer.from(
      JSON.stringify({ type: 'filesync-hello', deviceId, deviceName, syncPort })
    )
    for (const bcast of getBroadcastAddresses()) {
      socket?.send(payload, 0, payload.length, DISCOVERY_PORT, bcast)
    }
  }

  broadcastInterval = setInterval(announce, BROADCAST_INTERVAL)
}

export function stopDiscovery(): void {
  if (broadcastInterval) clearInterval(broadcastInterval)
  socket?.close()
  socket = null
}

export function getKnownPeers(): PeerInfo[] {
  const cutoff = Date.now() - PEER_STALE_MS
  return Array.from(knownPeers.values()).filter((p) => p.lastSeen > cutoff)
}
