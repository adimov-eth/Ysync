// Offscreen document entry: owns the PeerHub, terminates "media" ports from
// content scripts and "ui" ports from the popup. Only chrome.runtime here.

import { parsePortMsg, parseUiMsg, type PortMsg } from "../lib/proto.js"
import { runtimeSendMessage } from "../lib/ext.js"
import type { Program } from "../lib/types.js"
import { PeerHub, type RoomState } from "./peerhub.js"

type MediaPort = { port: chrome.runtime.Port; instanceId: string; tabId: number }

const mediaPorts = new Map<number, MediaPort>() // tabId → live port (at most one per tab)
const uiPorts = new Set<chrome.runtime.Port>()
let latestRoomState: RoomState | null = null

const postToMediaPorts = (msg: PortMsg): void => {
  for (const mp of mediaPorts.values()) {
    try {
      mp.port.postMessage(msg)
    } catch {
      // port died; onDisconnect cleans up
    }
  }
}

const postRoomState = (): void => {
  if (latestRoomState === null) return
  for (const p of uiPorts) {
    try {
      p.postMessage({ t: "roomState", state: latestRoomState })
    } catch {
      // popup closed mid-push
    }
  }
}

const notifySw = (msg: unknown): void => {
  const sameContextBridge = globalThis as typeof globalThis & {
    __chorusHandleSwMessage?: (msg: unknown) => Promise<boolean>
  }
  if (sameContextBridge.__chorusHandleSwMessage !== undefined) {
    void sameContextBridge.__chorusHandleSwMessage(msg).catch(() => undefined)
    return
  }
  void runtimeSendMessage({ target: "sw", msg }).catch(() => {
    // SW asleep and no listener yet — it will pull state on wake paths.
  })
}

const hub = new PeerHub({
  onRoomState: (s) => {
    latestRoomState = s
    postRoomState()
  },
  onBeacon: (beacon) => postToMediaPorts({ t: "beacon-relay", beacon }),
  onEv: (ev) => postToMediaPorts({ t: "ev-relay", ev }),
  onClockMap: (hostOffsetMs, uncMs, locked) =>
    postToMediaPorts({ t: "clock-map", hostOffsetMs, uncMs, locked }),
  onConnState: (state) => postToMediaPorts({ t: "conn", state }),
  onProgramChanged: (program: Program | null) => notifySw({ t: "program-changed", program }),
  onRoomActive: (active) => notifySw({ t: "room-active", active }),
})

// Push roomState at 1 Hz while any UI port exists (§5.2).
setInterval(() => {
  if (uiPorts.size > 0) {
    latestRoomState = hub.roomStateSnapshot()
    postRoomState()
  }
}, 1000)

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === "media") {
    handleMediaPort(port)
  } else if (port.name === "ui") {
    handleUiPort(port)
  }
  // Other names: not ours — ignore without disconnecting (§5.2).
})

const handleMediaPort = (port: chrome.runtime.Port): void => {
  const tabId = port.sender?.tab?.id
  if (tabId === undefined) {
    port.disconnect()
    return
  }
  let hello = false

  port.onMessage.addListener((raw: unknown) => {
    const parsed = parsePortMsg(raw)
    if (!parsed.ok) return
    const msg = parsed.value

    // First message MUST be mediaHello (§5.2); a new hello from the same tab
    // supersedes the old port.
    if (!hello) {
      if (msg.t !== "mediaHello") {
        port.disconnect()
        return
      }
      const existing = mediaPorts.get(tabId)
      if (existing !== undefined && existing.instanceId !== msg.instanceId) {
        existing.port.disconnect()
      }
      mediaPorts.set(tabId, { port, instanceId: msg.instanceId, tabId })
      hello = true
      return
    }

    switch (msg.t) {
      case "ping": {
        // Local-hop clock responder: same NTP shape as the P2P hop.
        const t1 = performance.now()
        try {
          port.postMessage({ t: "pong", id: msg.id, t0: msg.t0, t1, t2: performance.now() })
        } catch {
          // dead port
        }
        return
      }
      case "sample":
        hub.hostSample(msg.snap, msg.uncMs)
        return
      case "media-ev":
        if (msg.kind !== "external-ratechange") {
          hub.hostMediaEv(msg.kind, msg.ad)
        }
        return
      case "state-report":
        hub.guestStatus(msg.state, msg.eMs, msg.jitterMs)
        return
      default:
        return // relay/clock-map/conn/controlled flow the other way
    }
  })

  port.onDisconnect.addListener(() => {
    const existing = mediaPorts.get(tabId)
    if (existing?.port === port) mediaPorts.delete(tabId)
  })
}

const handleUiPort = (port: chrome.runtime.Port): void => {
  uiPorts.add(port)
  // Immediate snapshot so the popup renders without waiting for the tick.
  try {
    port.postMessage({ t: "roomState", state: hub.roomStateSnapshot() })
  } catch {
    // popup closed already
  }

  port.onMessage.addListener((raw: unknown) => {
    const parsed = parseUiMsg(raw)
    if (!parsed.ok) return
    const msg = parsed.value
    void (async () => {
      switch (msg.t) {
        case "createRoom":
          hub.createRoom(msg.name, msg.lanOnly)
          return
        case "addPeer": {
          const r = await hub.addPeer()
          if (!r.ok) port.postMessage({ t: "error", reason: r.error })
          return
        }
        case "acceptAnswer": {
          const r = await hub.acceptAnswer(msg.blob)
          if (!r.ok) port.postMessage({ t: "error", reason: r.error })
          return
        }
        case "join": {
          const r = await hub.join(msg.blob, msg.name, msg.lanOnly)
          if (r.ok) {
            port.postMessage({ t: "answerBlob", blob: r.value })
          } else {
            port.postMessage({ t: "error", reason: r.error })
          }
          return
        }
        case "leave":
        case "endRoom":
          hub.leave()
          return
        default:
          return
      }
    })()
  })

  port.onDisconnect.addListener(() => {
    uiPorts.delete(port)
  })
}
