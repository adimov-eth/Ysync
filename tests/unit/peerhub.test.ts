import { afterEach, describe, expect, it, vi } from "vitest"
import { PeerHub } from "../../src/offscreen/peerhub.js"
import type { RoomState } from "../../src/offscreen/peerhub.js"
import type { Beacon, Ev } from "../../src/lib/proto.js"
import type { Program } from "../../src/lib/types.js"

type TestPeer = {
  pingTimer: ReturnType<typeof setTimeout> | null
  graceTimer: ReturnType<typeof setTimeout> | null
  restartTimer: ReturnType<typeof setTimeout> | null
}

type TestPeerHub = {
  newPeer: (pc: RTCPeerConnection, name: string) => TestPeer
  wirePc: (peer: TestPeer) => void
}

type TestPc = {
  connectionState: RTCPeerConnectionState
  onconnectionstatechange: (() => void) | null
  close: () => void
}

const events = {
  onRoomState: (_s: RoomState): void => {},
  onBeacon: (_b: Beacon): void => {},
  onEv: (_ev: Ev): void => {},
  onClockMap: (_offsetMs: number, _uncMs: number, _locked: boolean): void => {},
  onConnState: (_s: "connected" | "coasting" | "rejoinable"): void => {},
  onProgramChanged: (_p: Program | null): void => {},
  onRoomActive: (_active: boolean): void => {},
}

describe("PeerHub connection timers", () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it("keeps the P2P clock ping loop alive when RTC state becomes connected", () => {
    vi.useFakeTimers()

    const hub = new PeerHub(events) as unknown as TestPeerHub
    const pc: TestPc = {
      connectionState: "new",
      onconnectionstatechange: null,
      close: vi.fn(),
    }
    const peer = hub.newPeer(pc as unknown as RTCPeerConnection, "guest")
    peer.pingTimer = setTimeout(() => {}, 10_000)
    peer.graceTimer = setTimeout(() => {}, 10_000)
    peer.restartTimer = setTimeout(() => {}, 10_000)

    hub.wirePc(peer)
    pc.connectionState = "connected"
    pc.onconnectionstatechange?.()

    expect(peer.graceTimer).toBeNull()
    expect(peer.restartTimer).toBeNull()
    expect(peer.pingTimer).not.toBeNull()
  })
})
