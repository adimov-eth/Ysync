import { describe, expect, it } from "vitest"
import {
  allowedFrom, parsePortMsg, parseSwMsg, parseUiMsg, parseWire, parseWireObject,
  sanitizeName, type Beacon, type Snap, type Wire,
} from "../../src/lib/proto.js"
import { mulberry32 } from "../helpers/prng.js"

const snap: Snap = {
  program: { service: "youtube", mediaId: "dQw4w9WgXcQ" },
  mediaTime: 42.5,
  hostClock: 123456.7,
  rate: 1,
  playing: true,
  buffering: false,
  adActive: false,
}

const beacon: Beacon = {
  t: "beacon", seq: 10, epoch: 2,
  program: snap.program,
  mediaTime: 42.5, hostClock: 123456.7, rate: 1,
  playing: true, buffering: false, adActive: false, uncMs: 0.4,
}

describe("parseWire — valid messages", () => {
  const valid: Wire[] = [
    { t: "hello", protoVersion: 1, peerId: "abcd2345", name: "Alice" },
    { t: "welcome", roomId: "abcd2345", hostName: "Bob", epoch: 0, snap },
    { t: "ping", id: 1, t0: 100.5 },
    { t: "pong", id: 1, t0: 100.5, t1: 101, t2: 101.1 },
    beacon,
    { t: "ev", epoch: 3, kind: "seek", snap },
    { t: "status", state: "locked", eMs: 2.1, jitterMs: 0.8 },
    { t: "restart-offer", blob: "abc" },
    { t: "restart-answer", blob: "def" },
    { t: "bye" },
  ]
  for (const msg of valid) {
    it(`accepts ${msg.t}`, () => {
      const r = parseWire(JSON.stringify(msg))
      expect(r.ok).toBe(true)
      if (r.ok) expect(r.value.t).toBe(msg.t)
    })
  }
})

describe("parseWire — rejection", () => {
  it("rejects non-string input", () => {
    expect(parseWire(42).ok).toBe(false)
    expect(parseWire(null).ok).toBe(false)
    expect(parseWire({ t: "bye" }).ok).toBe(false)
  })

  it("rejects oversized messages", () => {
    expect(parseWire(JSON.stringify({ t: "bye", pad: "x".repeat(10_000) })).ok).toBe(false)
  })

  it("rejects NaN/Infinity smuggled as numbers", () => {
    expect(parseWireObject({ t: "ping", id: 1, t0: NaN }).ok).toBe(false)
    expect(parseWireObject({ t: "ping", id: Infinity, t0: 0 }).ok).toBe(false)
    expect(parseWireObject({ ...beacon, mediaTime: Infinity }).ok).toBe(false)
  })

  it("rejects beacon missing uncMs", () => {
    const { uncMs: _drop, ...rest } = beacon
    expect(parseWireObject(rest).ok).toBe(false)
  })

  it("rejects unknown t", () => {
    expect(parseWire(JSON.stringify({ t: "exec", cmd: "rm -rf" })).ok).toBe(false)
  })

  it("rejects bad ev kind", () => {
    expect(parseWireObject({ t: "ev", epoch: 0, kind: "explode", snap }).ok).toBe(false)
  })

  it("rejects bad status state", () => {
    expect(parseWireObject({ t: "status", state: "root", eMs: 0, jitterMs: 0 }).ok).toBe(false)
  })

  it("sanitizes hello names", () => {
    const r = parseWireObject({ t: "hello", protoVersion: 1, peerId: "x", name: "a\u0007b".repeat(30) })
    expect(r.ok).toBe(true)
    if (r.ok && r.value.t === "hello") {
      expect(r.value.name).not.toContain("\u0007")
      expect(r.value.name.length).toBeLessThanOrEqual(24)
    }
  })
})

describe("parseWire — fuzz: garbage never throws, always Err", () => {
  it("survives 5000 random inputs", () => {
    const rng = mulberry32(1234)
    const tokens = [
      '{', '}', '[', ']', '"t"', ':', '"beacon"', '"ev"', 'null', 'true',
      '1e309', '-0', '"\\u0000"', ',', '"seq"', '"snap"', '"__proto__"', '1',
    ]
    for (let i = 0; i < 5000; i++) {
      let s = ""
      const len = 1 + Math.floor(rng() * 20)
      for (let j = 0; j < len; j++) s += tokens[Math.floor(rng() * tokens.length)]
      const r = parseWire(s) // must not throw
      if (r.ok) {
        // If it parsed, it must be a fully-typed Wire — spot-check the tag.
        expect(typeof r.value.t).toBe("string")
      }
    }
  })

  it("survives structured garbage (valid JSON, wrong shapes)", () => {
    const rng = mulberry32(99)
    const vals: unknown[] = [null, 0, -1, 1e308, "", "x", [], {}, true, { t: null }]
    const keys = ["t", "seq", "epoch", "snap", "program", "mediaTime", "hostClock", "id", "t0", "state", "blob", "uncMs"]
    for (let i = 0; i < 2000; i++) {
      const obj: Record<string, unknown> = {}
      for (const k of keys) if (rng() < 0.5) obj[k] = vals[Math.floor(rng() * vals.length)]
      if (rng() < 0.5) obj.t = ["beacon", "ev", "hello", "ping", "pong", "status"][Math.floor(rng() * 6)]
      expect(() => parseWireObject(obj)).not.toThrow()
    }
  })
})

describe("peer-trust filter (§14)", () => {
  it("follower-only messages rejected from host and vice versa", () => {
    expect(allowedFrom({ t: "hello", protoVersion: 1, peerId: "x", name: "" }, "host")).toBe(false)
    expect(allowedFrom({ t: "hello", protoVersion: 1, peerId: "x", name: "" }, "follower")).toBe(true)
    expect(allowedFrom(beacon, "follower")).toBe(false)
    expect(allowedFrom(beacon, "host")).toBe(true)
    expect(allowedFrom({ t: "ev", epoch: 0, kind: "play", snap }, "follower")).toBe(false)
    expect(allowedFrom({ t: "restart-offer", blob: "" }, "follower")).toBe(false)
    expect(allowedFrom({ t: "restart-answer", blob: "" }, "follower")).toBe(true)
    expect(allowedFrom({ t: "ping", id: 0, t0: 0 }, "host")).toBe(true)
    expect(allowedFrom({ t: "ping", id: 0, t0: 0 }, "follower")).toBe(true)
    expect(allowedFrom({ t: "bye" }, "host")).toBe(true)
  })
})

describe("parsePortMsg", () => {
  it("accepts a valid mediaHello and rejects proto mismatch", () => {
    const good = parsePortMsg({
      t: "mediaHello", proto: 1, instanceId: "abc123", service: "youtube",
      mediaId: "dQw4w9WgXcQ", adapterVersion: "1.0",
    })
    expect(good.ok).toBe(true)
    const bad = parsePortMsg({
      t: "mediaHello", proto: 2, instanceId: "abc123", service: "youtube",
      mediaId: null, adapterVersion: "1.0",
    })
    expect(bad.ok).toBe(false)
  })

  it("accepts sample with rebased snap + uncMs", () => {
    const r = parsePortMsg({ t: "sample", snap, uncMs: 0.3 })
    expect(r.ok).toBe(true)
  })

  it("rejects sample without uncMs", () => {
    expect(parsePortMsg({ t: "sample", snap }).ok).toBe(false)
  })

  it("never throws on garbage", () => {
    const rng = mulberry32(7)
    for (let i = 0; i < 1000; i++) {
      const x: unknown = rng() < 0.3 ? null : { t: ["sample", "clock-map", "media-ev", 7][Math.floor(rng() * 4)], kind: rng() }
      expect(() => parsePortMsg(x)).not.toThrow()
    }
  })
})

describe("parseUiMsg / parseSwMsg", () => {
  it("round-trips valid ui messages", () => {
    expect(parseUiMsg({ t: "createRoom", name: "Kitchen", lanOnly: false }).ok).toBe(true)
    expect(parseUiMsg({ t: "join", blob: "abc", name: "x", lanOnly: true }).ok).toBe(true)
    expect(parseUiMsg({ t: "leave" }).ok).toBe(true)
    expect(parseUiMsg({ t: "sudo" }).ok).toBe(false)
  })

  it("round-trips valid sw messages", () => {
    expect(parseSwMsg({ t: "register", service: "youtube", mediaId: "abc", audible: true }).ok).toBe(true)
    expect(parseSwMsg({ t: "register", service: "youtube", mediaId: null, audible: false }).ok).toBe(true)
    expect(parseSwMsg({ t: "need-offscreen" }).ok).toBe(true)
    expect(parseSwMsg({ t: "program-changed", program: null }).ok).toBe(true)
    expect(parseSwMsg({ t: "program-changed", program: { service: "spotify", mediaId: "x" } }).ok).toBe(true)
    expect(parseSwMsg({ t: "register", service: "netflix", mediaId: null, audible: true }).ok).toBe(false)
  })
})

describe("sanitizeName", () => {
  it("strips C0/C1 controls and caps at 24", () => {
    expect(sanitizeName("a\u0000\u001f\u007fb")).toBe("ab")
    expect(sanitizeName("x".repeat(100)).length).toBe(24)
    expect(sanitizeName("normal name")).toBe("normal name")
  })
})
