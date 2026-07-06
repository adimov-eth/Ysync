import { describe, expect, it } from "vitest"
import { decodePairBlob, encodePairBlob, randomId } from "../../src/offscreen/blob.js"
import type { PairBlob } from "../../src/lib/proto.js"

// A realistic Chrome SDP fixture (shape, not verbatim capture): the codec
// must round-trip it byte-identical (Appendix C golden test).
const SDP_FIXTURE = [
  "v=0",
  "o=- 4611731400430051336 2 IN IP4 127.0.0.1",
  "s=-", "t=0 0",
  "a=group:BUNDLE 0",
  "a=extmap-allow-mixed",
  "a=msid-semantic: WMS",
  "m=application 51372 UDP/DTLS/SCTP webrtc-datachannel",
  "c=IN IP4 192.168.1.23",
  "a=candidate:2999745851 1 udp 2122260223 df7d1cf3-4a35-4b4d-a0f7-6d8e3e3d9a2b.local 51372 typ host generation 0 network-id 1",
  "a=candidate:1038607390 1 udp 1686052607 203.0.113.7 51372 typ srflx raddr 0.0.0.0 rport 0 generation 0 network-id 1",
  "a=ice-ufrag:Xp7G",
  "a=ice-pwd:by2GZVXUyIporEmXCGH5Awzo",
  "a=ice-options:trickle",
  "a=fingerprint:sha-256 7B:8B:F0:65:5F:78:E2:51:3B:AC:6F:F3:3F:46:1B:35:DC:B8:5F:64:1A:24:C2:43:F0:A1:58:D0:A1:2C:19:08",
  "a=setup:actpass",
  "a=mid:0",
  "a=sctp-port:5000",
  "a=max-message-size:262144",
].join("\r\n") + "\r\n"

const NOW = 1_700_000_000_000

const mkBlob = (over: Partial<PairBlob> = {}): PairBlob => ({
  v: 1,
  kind: "offer",
  roomId: "abcd2345",
  peerId: "efgh6789",
  name: "Kitchen MacBook",
  ts: NOW,
  sdp: SDP_FIXTURE,
  ...over,
})

describe("blob codec", () => {
  it("round-trips byte-identical SDP", async () => {
    const enc = await encodePairBlob(mkBlob())
    expect(enc.length).toBeLessThan(6000)
    expect(enc).toMatch(/^[A-Za-z0-9_-]+$/)
    const dec = await decodePairBlob(enc, { nowMs: NOW + 1000 })
    expect(dec.ok).toBe(true)
    if (dec.ok) {
      expect(dec.value.sdp).toBe(SDP_FIXTURE)
      expect(dec.value.roomId).toBe("abcd2345")
      expect(dec.value.kind).toBe("offer")
    }
  })

  it("compresses to paste size (~400–1200 chars)", async () => {
    const enc = await encodePairBlob(mkBlob())
    expect(enc.length).toBeGreaterThan(100)
    expect(enc.length).toBeLessThan(1500)
  })

  it("rejects oversized encoded input before decoding", async () => {
    const dec = await decodePairBlob("A".repeat(6001), { nowMs: NOW })
    expect(dec.ok).toBe(false)
  })

  it("rejects a decompression bomb (highly compressible payload over the JSON cap)", async () => {
    const bomb = mkBlob({ sdp: "a".repeat(15_000), name: "x".repeat(200) })
    // Force the JSON itself over 20 KB by padding an unknown field via raw JSON.
    const raw = JSON.stringify({ ...bomb, pad: "z".repeat(50_000) })
    const stream = new Blob([raw]).stream().pipeThrough(new CompressionStream("deflate-raw"))
    const bytes = new Uint8Array(await new Response(stream).arrayBuffer())
    let bin = ""
    for (const b of bytes) bin += String.fromCharCode(b)
    const enc = btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "")
    expect(enc.length).toBeLessThanOrEqual(6000) // it IS paste-sized...
    const dec = await decodePairBlob(enc, { nowMs: NOW })
    expect(dec.ok).toBe(false) // ...but must die on the output cap
    if (!dec.ok) expect(dec.error.reason).toContain("too large")
  })

  it("rejects truncated input", async () => {
    const enc = await encodePairBlob(mkBlob())
    const dec = await decodePairBlob(enc.slice(0, enc.length - 10), { nowMs: NOW })
    expect(dec.ok).toBe(false)
  })

  it("rejects garbage base64url", async () => {
    const dec = await decodePairBlob("not!!valid@@base64", { nowMs: NOW })
    expect(dec.ok).toBe(false)
  })

  it("rejects expired blobs (TTL 10 min)", async () => {
    const enc = await encodePairBlob(mkBlob({ ts: NOW - 601_000 }))
    const dec = await decodePairBlob(enc, { nowMs: NOW })
    expect(dec.ok).toBe(false)
    if (!dec.ok) expect(dec.error.reason).toContain("expired")
  })

  it("rejects far-future ts", async () => {
    const enc = await encodePairBlob(mkBlob({ ts: NOW + 3_600_000 }))
    const dec = await decodePairBlob(enc, { nowMs: NOW })
    expect(dec.ok).toBe(false)
  })

  it("sanitizes names on decode", async () => {
    const enc = await encodePairBlob(mkBlob({ name: "evil\u0000name\u001b[31m that is way too long for a label" }))
    const dec = await decodePairBlob(enc, { nowMs: NOW })
    expect(dec.ok).toBe(true)
    if (dec.ok) {
      expect(dec.value.name).not.toContain("\u0000")
      expect(dec.value.name).not.toContain("\u001b")
      expect(dec.value.name.length).toBeLessThanOrEqual(24)
    }
  })

  it("rejects wrong version", async () => {
    const raw = JSON.stringify({ ...mkBlob(), v: 2 })
    const stream = new Blob([raw]).stream().pipeThrough(new CompressionStream("deflate-raw"))
    const bytes = new Uint8Array(await new Response(stream).arrayBuffer())
    let bin = ""
    for (const b of bytes) bin += String.fromCharCode(b)
    const enc = btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "")
    const dec = await decodePairBlob(enc, { nowMs: NOW })
    expect(dec.ok).toBe(false)
  })
})

describe("randomId", () => {
  it("is 8 base32 chars and collision-free over a small sample", () => {
    const seen = new Set<string>()
    for (let i = 0; i < 200; i++) {
      const id = randomId()
      expect(id).toMatch(/^[a-z2-7]{8}$/)
      seen.add(id)
    }
    expect(seen.size).toBe(200)
  })
})
