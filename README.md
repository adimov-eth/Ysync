# Chorus

Synchronized YouTube/Spotify playback across nearby Macs. Several people in
one room, each on their own MacBook, play the same video or track and it
sounds like one system — media clocks agree to within a few milliseconds and
stay locked through pauses, seeks, buffering, background tabs, and network
jitter.

**No backend. No accounts. No audio leaves any machine.** Pairing is two small
text blobs couriered by a human (AirDrop / clipboard); transport is
DTLS-encrypted WebRTC DataChannels, peer to peer. The only third party ever
touched is one public STUN server at pairing time — and the LAN-only toggle
removes even that.

Built to [docs/spec-v1.1.md](docs/spec-v1.1.md) (Chrome MV3, `minimum_chrome_version: 116`).

## Using it

1. `npm install && npm run build`, then load `dist/` unpacked at `chrome://extensions`.
2. **Host:** open the popup → *Create room* → *Add peer* → send the invite
   blob to a friend (AirDrop, iMessage, anything). Paste back their answer.
   Repeat per friend (up to 7).
3. **Guest:** popup → *Join room* → paste the invite → send back the answer
   blob that appears. Click the player once if asked (autoplay activation).
4. Host plays; everyone follows. Followers' players are host-authoritative —
   local pause/seek is overridden within a tick.

### Aligning the sound (ear test)

Bluetooth speakers add latency the sync math cannot see. On the follower:
host plays any steady-beat video, then drag the offset slider until the flam
disappears. **Positive = this machine's sound is late = its media clock runs
ahead.** The offset persists per machine.

### When pairing fails

If the connection isn't up 20 s after the answer is pasted, the popup names
the state. If both machines are behind hostile NATs with no shared Wi-Fi:
**put them on one Wi-Fi network or a phone hotspot and re-pair** — that is
the supported answer; there are no TURN relays by design.

## Privacy

- Permissions: `offscreen`, `storage`; content scripts on youtube.com and
  open.spotify.com only. No mic, no analytics, no remote code.
- Network: WebRTC to explicitly paired peers. The default STUN server
  (`stun.l.google.com`) learns each peer's public IP at pairing time — the
  sole external touchpoint (risk R5). LAN-only mode (`iceServers: []`) is
  zero external contact and works when machines share Wi-Fi with multicast.
- Invite blobs are single-use bearer tokens with a 10-minute TTL. Whoever
  answers first joins: the courier channel is the trust boundary.
- Peer IDs are room-scoped and regenerated per room — never a persistent
  device identifier.

## Accepted risks (decided, not forgotten)

- **R1 — Spotify fine-rate control is unproven.** We drive the raw media
  element; DRM may tolerate `playbackRate` trims or not. A runtime probe at
  join answers per-session; failure ships as labeled coarse mode
  (micro-seeks every 5 s), which is the guaranteed floor.
- **R2 — Site code may fight `playbackRate`.** The rate watchdog re-asserts
  once, then downgrades (halve trim → coarse) on persistent conflict. Every
  transition surfaces as a chip change.
- **R3 — Chrome SDP drift.** We ship compressed raw SDP, not a
  reconstruction template.
- **R4 — Internet-path clock quality.** Summed clock uncertainty above 5 ms
  ⇒ `clock_degraded`, fine sync withheld. The gate is never widened.
- **R5 — STUN privacy.** See Privacy; LAN-only toggle is the mitigation.

## Development

```
npm run typecheck   # tsc strict, all contexts + tests
npm test            # unit: clock filter, sampler fit, servo law, watchdog,
                    #       blob codec (incl. bomb rejection), proto fuzz
npm run sim         # two virtual peers, ±50 ppm skew, 0–10 ms msg jitter:
                    #       p95 ≤ 15 ms after settle, ≤ 25 ms at 1 Hz ticks,
                    #       watchdog downgrade on a rate-disobedient element
npm run e2e         # playwright: two real Chrome profiles pair over real
                    #       WebRTC (blob hand-off) + full media sync over the
                    #       fixture adapter (converge, seek, pause)
npm run build       # dist/ (production) + dist-e2e/ (adds localhost matches)
```

Layout follows the spec (§16): `src/lib/` is pure (no `chrome.*`, fully
unit-testable), shells (`sw`, `offscreen/`, `content/`, `popup/`) hold all
effects. Every protocol ingress parses to a typed value or an `Err` — no
message shape is trusted.

### Architecture in one breath

The **service worker** is ephemeral: it only creates/destroys the offscreen
document and elects one *controlled tab* per machine (registry in
`chrome.storage.session`, so election survives SW restarts). The **offscreen
document** owns every `RTCPeerConnection` (star topology, host-centered),
the P2P clock hop, beacon fan-out, and the reconnect ladder
(`coasting → host-only restartIce while control still flows → rejoinable`).
The **content script** owns the media adapter, the sampler
(rVFC / edge-poll), the servo (P-only, slew-limited, deadband), the
activation machine (incl. muted-bridge), the rate probe/watchdog, and ad
defense. The **popup** renders state pushed over its own port and writes
settings.

Timeline: everything maps to host-offscreen `performance.now()` via two
measured NTP-style hops (P2P and local). `Date.now()` appears exactly once
(blob TTL) and never in sync math.

## Deltas from spec v1.1 (v1.2 candidates, found during implementation)

1. **Edge timestamps at the poll-interval midpoint** (`sampler.ts`, sim).
   Stamping an edge at its detection tick is late by up to a full poll
   period — a phase-locked bias the robust fit cannot average away. The sim
   failed its own 15 ms AC until this was fixed; spec §9 should mandate it.
2. **Beacons carry `uncMs`** — the host's content↔offscreen hop uncertainty
   was invisible to followers' fine-sync gates in v1.1; now it is summed.
3. **Clock filter best-K fallback.** The relative RTT gate (min + 2 ms) can
   keep almost nothing on jittery paths; the filter falls back to the 5
   lowest-rtt samples, and their spread shows up honestly in `uncMs`.
4. **SW election registry persists in `chrome.storage.session`** — a v1.1
   gap: the ephemeral SW would forget all registered tabs on restart.
5. **Stale-epoch beacons dropped explicitly** (`epoch < current`), and beacon
   `seq` never resets across epoch bumps — the cross-channel race (reliable
   `control` vs unordered `state`) is real.
6. **Convergence AC arithmetic:** with TAU=2 s, maxTrim=0.02, slew=0.02/s²,
   draining a 100 ms error takes ≈ 6.3 s with a perfect clock; the spec's
   "< 6 s" is not reachable with its own constants. The sim asserts < 12 s
   including ~2 s clock warmup.
7. **Fixture is a synthesized WAV, not a MediaRecorder capture** — recorded
   webm blobs have `duration: Infinity` and unreliable seeking in Chrome;
   PCM WAV is trivially seekable and rate-adjustable.
8. **Epoch hard-syncs are clock-gated:** discontinuities may seek without
   fine-trim preconditions, but never when summed clock uncertainty exceeds
   10× the fine gate — "never seek on a bad clock" made precise.

## Manual test matrix (two real MacBooks — not automatable here)

- [ ] Same Wi-Fi: pair, sync, p95 drift readout ≤ 15 ms after 30 s
- [ ] Different networks (hotspot vs home): pair via STUN
- [ ] AP-isolated Wi-Fi: srflx rescue or the scripted failure message
- [ ] LAN-only mode on shared Wi-Fi
- [ ] Hidden follower tab: drift ≤ 25 ms p95
- [ ] Lid close/open: re-lock ≤ 5 s
- [ ] Bluetooth speaker + slider ear-test alignment
- [ ] Spotify probe outcome recorded (either result acceptable — R1)
- [ ] DevTools-forced `playbackRate` interference → watchdog downgrade chip
- [ ] Kill offscreen doc (chrome://serviceworker-internals) → `rejoinable` → one-blob re-pair
