# Chorus — Synchronized YouTube/Spotify Playback Across Nearby Macs

**Engineering specification for implementation by a coding agent.**
Version 1.1 · Target: Chrome (MV3) only, `minimum_chrome_version: 116` · Working name "Chorus"

**Changelog v1.0 → v1.1** (post-review):
- Networking reframed: rooms share air, not a network. One public STUN server by default; ICE picks host/mDNS candidates automatically when machines happen to share Wi-Fi. "Same-subnet only" non-goal deleted. LAN-only privacy toggle added.
- Signaling ships **compressed raw SDP** (v1.0's reconstruction template demoted to backlog).
- New §9 **media-clock sampler**: rVFC for video, edge-detected polling for audio, per-adapter jitter budget. `timeupdate` demoted to a scheduling tick — never a sample source.
- Servo: slew limit, adaptive deadband, **rate watchdog** against page code fighting `playbackRate`, unified `PeerSyncState`, explicit autoplay/activation machine with muted-bridge state.
- Offscreen realism: no extension APIs there except `runtime`; storage map defined; `offscreen_lost → recreate → rejoinable` recovery; popup gets a direct UI port (SW no longer mirrors state on a timer).
- ICE restart made conservative: grace → `restartIce()` only while the control channel still flows → otherwise `rejoinable`. Host-only initiates.
- Hardening: port handshake with `instanceId`, crypto-random IDs, decompression caps, name sanitization, DOM-only adapter mandate.
- **Acoustic auto-calibration removed from v1** → backlog (§21). Manual offset slider + ear-test remain P0. Mic permission and `USER_MEDIA` reason dropped from manifest.
- **Spotify feasibility spike skipped by decision** — carried as accepted risk R1 with runtime guards (§3, §9.5, §12).

---

## 0. Problem statement

Several people in one room, each on their own MacBook, want to play the *same* YouTube video or Spotify track and have it sound like one system. Media clocks must agree to within a few milliseconds and stay locked through pauses, seeks, buffering, background tabs, and network jitter. The machines share a room — **not necessarily a network**. No backend, no accounts, no audio leaves any machine.

## 1. Goals

- **G1 — Media-clock lock:** p95 absolute sync error ≤ 15 ms between any follower and the host after a 30 s settle, *whenever fine-sync preconditions hold* (§10.1: fine rate control available, sampler jitter ≤ 5 ms, clock uncertainty ≤ 5 ms). Outside those preconditions the peer degrades honestly (coarse mode / HOLD) and says so in the UI — it never silently claims lock.
- **G2 — Serverless signaling, direct P2P transport:** no backend. Pairing = physically exchanging two small text blobs (AirDrop / Universal Clipboard / paste). Transport = WebRTC DataChannels, DTLS-encrypted, peer-to-peer. The only third party ever touched is one public STUN server for candidate discovery (§6.5; disable-able).
- **G3 — Manual acoustic offset:** per-machine output-latency offset via a live ±500 ms slider (1 ms steps), persisted, plus a documented ear-test procedure. (Automatic chirp calibration: backlog, §21.)
- **G4 — Inaudible correction:** sync maintained via `playbackRate` micro-trims with slew limiting; hard seeks only on join, host discontinuity, or gross divergence.
- **G5 — Host authority, honestly measured:** host play/pause/seek/track-change is *applied to the follower's media element* within 500 ms of the host-side event. Time-to-audible-convergence is measured and reported separately (buffering and activation can dominate it and are outside our control).

## 2. Non-goals (v1)

- **No audio streaming between machines.** Each machine plays its own Premium stream; we sync clocks only.
- **No cross-service sync.** A room plays one *program* = `(service, mediaId)`.
- **No TURN relays.** Direct paths only (host candidates or STUN-derived srflx). The unreachable case — symmetric/hostile NAT on both ends — has a physical workaround: people in one room can always hotspot. Documented, not engineered around.
- **No automatic acoustic calibration** (chirps, mic capture) — backlog §21. v1 ships the slider + ear test.
- **No MAIN-world script injection.** Adapters are isolated-world DOM-only (§12.1).
- **No ad-supported tiers as a first-class flow.** Everyone is assumed Premium; ads get defensive handling only (§11).
- **No playlist/queue mirroring** beyond the currently playing item; no Shorts; no browsers other than Chrome.
- **Swift/Bonjour zero-touch discovery** — backlog §21.

## 3. Accepted risks (decided, not forgotten)

These were consciously accepted instead of being resolved by pre-build spikes. Each has a runtime guard so failure degrades visibly rather than silently.

- **R1 — Spotify fine-rate control is unproven.** Spotify's official SDK surface has no rate control; we drive the raw media element, which may tolerate trims — or may not, or may be reset by site code. *Guards:* runtime rate probe at join (§9.5), continuous rate watchdog (§10.4), coarse-mode fallback (§10.5), `unsupported` state in UI. *Decision point:* M3 — whichever way the probe lands on real Premium accounts, that outcome ships (fine sync or labeled coarse mode). Elaboration deferred by explicit decision.
- **R2 — Site code may fight `playbackRate`** (both services; players re-assert state on quality switches, track changes, SPA navigation). *Guard:* watchdog (§10.4) — detect external `ratechange`, re-assert once, downgrade on persistent conflict.
- **R3 — Chrome SDP/API drift.** Mitigated by shipping raw SDP (§6.2) instead of a reconstruction template; template optimization deferred to backlog with golden tests.
- **R4 — Internet-path clock quality.** When peers connect via srflx (different networks / AP isolation), RTT jitter can push clock uncertainty past the 5 ms gate. We do **not** widen the gate; the peer holds fine sync and shows `clock_degraded`. Refinement (a degraded-sync band) deferred until real data exists.
- **R5 — STUN privacy.** The default STUN server learns each peer's public IP at pairing time — the sole external touchpoint in the system. Mitigation: "LAN-only mode" toggle sets `iceServers: []` (works when machines share Wi-Fi that permits mDNS/multicast).

## 4. User stories

- As the **host**, I create a room, hand each friend an invite blob (AirDrop), paste back their answer, and from then on whatever I play, everyone hears in lockstep.
- As a **follower**, I paste the invite, send back my answer, click the player once (activation), and never touch my player again.
- As a **follower on laggy Bluetooth speakers**, I drag the offset slider while a steady beat plays until the flam disappears, and that offset persists across sessions.
- As **any peer**, if my machine hits an ad (defensive case), it mutes itself, waits, and snaps back into sync within a second of the ad ending — nobody re-pairs.
- As **any peer**, when Wi-Fi blips, my machine coasts briefly and self-heals; when the link truly dies (or the offscreen document is killed), the UI tells me exactly one action: re-pair with one blob.

---

## 5. System architecture

Four extension contexts. **The service worker is ephemeral and owns no live state and no important timers.** Long-lived connection state lives in the offscreen document; media-adjacent logic lives in the content script.

```
┌─────────┐   "ui" Port (while open)                ┌──────────────────┐
│  Popup   │◄───────────────────────────────────────►│ Offscreen document│
│ (room UI)│                                          │  "PeerHub"        │
└────┬────┘                                          │ • RTCPeerConn ×N  │
     │ runtime msgs (lifecycle only)                  │ • clock master/   │
┌────▼────────────┐  runtime msgs (lifecycle only)    │   slave (P2P hop) │
│ Service worker   │◄────────────────────────────────►│ • beacon fan-out  │
│ (broker: offscreen│                                 └───────▲──────────┘
│ lifecycle + tab   │                          "media" Port   │ (long-lived,
│ election, nothing │                          handshake +    │  hot path)
│ else)             │                          backoff        ▼
└──────────────────┘                                 ┌──────────────────┐
                                                     │ Content script    │
                                                     │ (youtube/spotify) │
                                                     │ • MediaAdapter    │
                                                     │ • Sampler + Servo │
                                                     │ • clock local hop │
                                                     └──────────────────┘
```

### 5.1 Context responsibilities

| Context | Owns | Never does |
|---|---|---|
| **Service worker** (`sw.ts`) | Offscreen lifecycle (create via `chrome.offscreen.createDocument`, existence check via `chrome.runtime.getContexts()`); controlled-tab election (§5.3); relaying lifecycle messages; reading settings to inject into offscreen create/join calls | Hold sockets, room state, or timers that matter; touch the hot path |
| **Offscreen doc** (`offscreen.ts`) | All `RTCPeerConnection`s (star, host-centered); NTP filter for the P2P hop; beacon fan-out (host) / relay (follower); blob encode/decode; ICE restart logic; pushing `roomState` to the popup's UI port on change + 1 Hz *while that port exists* | Touch any site's DOM; run the servo; call any extension API except `chrome.runtime` (that's all it has — see §5.4) |
| **Content script** (`content.ts` + adapters) | `MediaAdapter`; media-clock **sampler** (§9); servo (§10); NTP filter for the local hop; ad detection; activation toasts; reading `offsetMs` from `chrome.storage` (+`onChanged`) | Own the peer connection; run when not the controlled tab |
| **Popup** (`popup.ts`) | Room lifecycle UI, blob copy/paste, status readout (via its own port to offscreen), offset slider (writes `chrome.storage`), Rejoin/Leave | Any protocol logic |

### 5.2 Ports and routing — hard invariants

- Content ↔ offscreen: long-lived Port `chrome.runtime.connect({ name: "media" })`. **Only the offscreen document attaches a handler for ports named `"media"`**; SW and popup must not listen for (or must immediately ignore without disconnecting) that name. `runtime.onConnect` can fire in multiple contexts and more than once — the name filter plus the handshake below make this safe.
- **First message on a `"media"` port must be** `mediaHello { proto: 1, instanceId, service, mediaId, adapterVersion }`, where `instanceId` is `crypto.getRandomValues`-derived per content-script life. Offscreen keeps at most one live media port per tab: a new `mediaHello` from the same tab supersedes the old port (old one is closed); duplicate/stale instances are rejected with a typed error.
- If the offscreen document doesn't exist yet, `connect` fails / the port disconnects immediately: content script retries with bounded exponential backoff (250 ms → 4 s, ×2) and pings the SW (`{target:"sw", msg:{t:"need-offscreen"}}`) so the SW can recreate it if a room is supposed to be active.
- Popup ↔ offscreen: Port `"ui"`, only while the popup is open. Offscreen pushes `roomState` on change + 1 Hz to this port. **No SW-side mirroring, no SW timers** (v1.0's 1 Hz SW mirror is deleted — an ephemeral SW cannot own a heartbeat).
- Everything else (rare lifecycle traffic) uses one-shot `runtime` messages with envelopes `{ target: "sw" | "offscreen" | "popup", msg }`; contexts ignore envelopes not addressed to them.

### 5.3 Controlled-tab election

Each content script registers with the SW on load: `{service, mediaId, audible}` (SW learns the tab from `sender.tab`). The SW designates exactly one *controlled tab* per machine — the registered tab matching the room's program, preferring audible / most recently registered — and **explicitly pushes** `controlled: true|false` to each content script. Non-controlled tabs run no sampler, no servo, no port traffic beyond registration. Re-election on tab close, navigation, or program change.

### 5.4 Offscreen document: capabilities and recovery

Offscreen documents get **only `chrome.runtime`** — no `chrome.storage`, no `tabs`. Consequences, made explicit:

- **Storage map:** popup *writes* settings (`deviceName`, `lanOnly`, `offsetMs`); content script *reads* `offsetMs` (+ `storage.onChanged`) for the servo; SW *reads* `deviceName`/`lanOnly` and passes them as parameters inside the `createRoom` / `joinRoom` message to offscreen. Offscreen persists nothing and holds config only as message-passed values.
- **`offscreen_lost` recovery:** the offscreen doc can be destroyed (crash, Chrome housekeeping, extension reload). Detection: every `"media"`/`"ui"` port fires `onDisconnect`; content script notifies SW (`need-offscreen`); SW checks `getContexts()`, and if a room was active, recreates the document. The fresh offscreen has no peers: it enters `rejoinable` room state — popup surfaces "Re-invite ⟨name⟩" (host) / "Rejoin" paste field (guest). Remote peers see `connectionState: failed` and land in `rejoinable` symmetrically. WebRTC state is *not* recoverable by design; the recovery product is a clean one-blob re-pair, never a zombie.
- Exactly one offscreen document per profile: guard creation with `getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] })` (Chrome 116+; hence the manifest minimum). Do not use `chrome.offscreen.hasDocument()` as the primary path.

---

## 6. Signaling — serverless pairing

### 6.1 Model

WebRTC needs a few hundred bytes exchanged each way, once per peer, before the P2P link exists. The human is the courier. **Non-trickle ICE:** wait for `iceGatheringState === "complete"`, then serialize `pc.localDescription.sdp` — candidates embedded by the browser — as one blob per direction.

- Topology: **star**, one `RTCPeerConnection` per follower on the host. Adding peer *k* = one offer blob out, one answer blob back.
- DTLS roles fixed: host offers, guest answers. (Also the glare rule for restarts, §6.4.)

### 6.2 Blob format — compressed raw SDP (v1.1 decision)

Raw SDP, not a reconstruction: simpler, robust to Chrome SDP-shape changes (risk R3), still paste-sized after compression. The v1.0 minimized-template design moves to backlog (§21) behind golden tests.

```ts
type PairBlob = Readonly<{
  v: 1
  kind: "offer" | "answer"
  roomId: string        // 8 base32 chars, crypto.getRandomValues
  peerId: string        // 8 base32 chars, crypto random, room-scoped (regenerated per room)
  name: string          // human label, ≤ 24 chars, control chars stripped
  ts: number            // Date.now(), TTL only — never used in sync math
  sdp: string           // pc.localDescription.sdp, verbatim, post-gathering
}>
```

Encode: `JSON → CompressionStream("deflate-raw") → base64url` (~400–800 chars typical). Decode is the mirror, with **hard caps enforced before and after decompression**: encoded length ≤ 6 000 chars, decompressed JSON ≤ 20 KB, `sdp` ≤ 16 KB, else reject (decompression-bomb guard). Then schema-parse (`Result`, §16), check `v`, TTL (`BLOB_TTL_S`), and apply via `setRemoteDescription({ type: kind, sdp })`. The SDP string is attacker-controlled input until `setRemoteDescription` accepts it — never interpolate it into UI or logs beyond length-capped debug output; render `name` via `textContent` only.

### 6.3 Pairing flows

**Host — Add peer:** popup → offscreen `addPeer` → new `RTCPeerConnection` → `createDataChannel` ×3 (§7.1) → `createOffer` → `setLocalDescription` → await gathering complete → blob → popup copy button. Host pastes the guest's answer blob → `setRemoteDescription` → connected → guest's `hello` invalidates the offer blob (single-use).

**Guest — Join:** popup paste offer blob → offscreen builds `RTCPeerConnection` (`ondatachannel` mode) → `setRemoteDescription` → `createAnswer` → gathering complete → answer blob → courier back.

**Security semantics:** the offer blob is a **single-use bearer token**, TTL 10 min. Whoever answers first joins. The courier channel (AirDrop point-to-point, in-room paste) is the trust boundary; after that, DTLS with fingerprints pinned inside the exchanged SDP. No pretend second factor.

**Couriers (UX, not protocol):** Copy → AirDrop / Universal Clipboard → Paste (primary). QR render+scan and audio-modem chirp: backlog.

### 6.4 Liveness, grace, and reconnect (conservative model)

Heartbeat = the 1 Hz clock pings (§7.3); no separate heartbeat protocol. Per-peer connection state machine in offscreen:

```
connected
  └─ connectionState "disconnected" → COASTING (grace GRACE_S = 10):
       followers: servo → HOLD, keep playing blind at rate 1 (drift ≈ clock skew, negligible over 10 s)
       • often self-heals → connected
       • after 5 s still disconnected AND control.readyState === "open" AND host side:
           host calls pc.restartIce() → onnegotiationneeded → createOffer →
           send {t:"restart-offer", blob} over control; guest answers {t:"restart-answer", blob}
       • restart succeeds → connected
  └─ connectionState "failed", or restart unanswered for RESTART_TIMEOUT_S = 10,
     or control channel closed → REJOINABLE:
       transport is dead — in-band signaling is gone with it; require manual one-blob re-pair.
       Room metadata (names, program) persists so re-pairing is a single round.
```

Rules: **host-only initiates restarts** (glare avoidance); a follower never calls `restartIce()`. Never attempt in-band restart when the only path for the restart offer is the transport being restarted and it is already `failed` — that was v1.0's optimism, corrected here.

### 6.5 Network paths (LAN assumption removed)

Default `RTCConfiguration`: `{ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] }`. ICE then does the right thing everywhere:

- **Same Wi-Fi:** host candidates (published as anonymized `<uuid>.local` mDNS names, resolved by the receiving Chrome via multicast) win the ICE race automatically — lowest RTT, no external traffic after pairing. This is the free fast path, not a requirement.
- **Different networks / AP-isolated Wi-Fi:** srflx (STUN-derived) candidates carry the room over the internet, including hairpin through the same AP where isolation blocks direct traffic. Clock quality may degrade → R4 behavior (`clock_degraded`, fine sync withheld, no gate-widening).
- **LAN-only mode** (settings toggle, off by default): `iceServers: []` — zero external contact; requires shared Wi-Fi with working multicast; pairing fails cleanly otherwise with the explanatory error below.
- **Both ends behind hostile NAT and no shared Wi-Fi:** no TURN by design (§2). Popup error text must name the workaround: "These machines can't reach each other directly. Put them on one Wi-Fi network or a hotspot and re-pair."

Pairing-failure UX: if the connection isn't `connected` within 20 s of answer paste, show the state (`checking`/`failed`), whether LAN-only is on, and the hotspot suggestion. Failure is an expected state with a script, not an edge case.

---

## 7. Transport channels & clock sync

### 7.1 DataChannels (created by host, per peer)

| Label | Options | Carries |
|---|---|---|
| `control` | ordered, reliable (defaults) | hello/welcome, events, status reports, ad flags, restart-offer/answer, bye |
| `clock` | `{ ordered: false, maxRetransmits: 0 }` | ping/pong only — datagram semantics, never head-of-line blocked; doubles as liveness heartbeat |
| `state` | `{ ordered: false, maxRetransmits: 0 }` | beacons; stale ones are worthless, latest-wins by `seq` |

### 7.2 Clocks — ground rules

- **Only monotonic clocks.** `performance.now()` everywhere; `Date.now()` appears exactly once (blob TTL) and never in sync math.
- Every JS context has its own `performance.now()` origin ⇒ every hop needs a measured offset. Exactly two hops: **P2P** (follower-offscreen ↔ host-offscreen) and **local** (content ↔ its own offscreen). The canonical timeline is host-offscreen `performance.now()` = `hostClock`.

### 7.3 NTP-style filter (shared `lib/clock.ts`, pure)

Requester sends `ping{id, t0}`; responder replies `pong{id, t0, t1, t2}`; requester stamps `t3`.

```
offset = ((t1 − t0) + (t2 − t3)) / 2      // responderClock − requesterClock
rtt    = (t3 − t0) − (t2 − t1)
```

Filter (pure function over a sample window):
- Sliding window `WINDOW = 32` at `PING_HZ = 1`; keep samples with `rtt ≤ min(rtt over window) + RTT_GATE_MS (2 ms)` — relative gating, so it works on internet paths too.
- `offset = median(kept)`, `uncertainty = MAD(kept)`.
- **Warmup burst:** 8 pings @ 4 Hz on channel open and after wake, before declaring `locked`.
- **Stale triggers** (→ `stale`, re-burst): scheduled-ping gap > 3 s (sleep/throttle), sustained rtt > 5× baseline, |offset jump| > 10 ms across 5 consecutive samples.
- No skew/PPM modeling in v1 — the P-law absorbs clock skew with negligible steady-state error (§10.3). Don't build it.

Local hop: same messages over the `"media"` port, continuously at 1 Hz. RTT is usually < 1 ms but event-loop jitter is real; same filter.

### 7.4 Composition

Follower content script computes `toHost(nowContent) = nowContent + offset_local + offset_p2p`. The follower's offscreen pushes `{hostOffsetMs, uncMs, locked}` to its media port at 1 Hz + on lock-state change; content adds its own local-hop offset. Summed uncertainty gates fine sync (§10.1); above the gate ⇒ `clock_degraded`, HOLD — never seek on a bad clock, never widen the gate (R4). On the host machine the same machinery runs with `offset_p2p = 0`; host content still measures its local hop so beacon timestamps rebase into `hostClock` precisely.

---

## 8. Program & state protocol

### 8.1 Definitions

- **Program** = `{ service: "youtube" | "spotify", mediaId }`. YouTube `mediaId` = `v` query param (`/watch` only). Spotify `mediaId` = track id from the now-playing bar's `/track/{id}` anchor.
- **Epoch** = integer, incremented by the host on every discontinuity: seek, program change, ad exit, recovery-after-stall. Followers servo *within* an epoch, hard-sync *across* epochs. This one integer distinguishes "time passed" from "host jumped".

### 8.2 Beacons (host → all, `state` channel, unordered)

Host content script samples via its **sampler** (§9) and pushes to host-offscreen, which rebases timestamps into `hostClock` and fans out at `BEACON_HZ = 3` (latest wins; degrades gracefully to ~1 Hz hidden — the design tolerates it, §10.3):

```ts
type Beacon = Readonly<{
  t: "beacon"; seq: number; epoch: number
  program: Program
  mediaTime: number       // seconds, host media position at hostClock
  hostClock: number       // ms, host-offscreen performance.now() domain
  rate: number            // host's own playbackRate (nominally 1)
  playing: boolean
  buffering: boolean      // host readyState/waiting — followers HOLD while true
  adActive: boolean
}>
```

Followers drop `seq ≤ lastSeq`.

### 8.3 Events (host → all, `control`, reliable)

`{ t:"ev", epoch, kind: "play"|"pause"|"seek"|"program"|"ad-start"|"ad-end", snap }` — emitted immediately on host media events; each carries the new epoch and a full snapshot so followers act without waiting for a beacon. Beacons are steady-state truth; events are the low-latency edge. After a host buffering stall resolves, host emits a `seek` event (position jumped relative to extrapolation).

### 8.4 Follower status (follower → host, `control`)

`{ t:"status", state: PeerSyncState, eMs, jitterMs }` at 1 Hz + on state change — feeds the host's peer-list chips. (New in v1.1; v1.0 had no upstream state reporting.)

### 8.5 Program mismatch

- **YouTube:** auto-follow via `location.assign("https://www.youtube.com/watch?v=" + mediaId)`. Full navigation reloads the content script; offscreen connection unaffected; media port re-handshakes on load.
- **Spotify:** programmatic navigation + autoplay is unreliable under DRM/gesture rules ⇒ in-page toast: *"Host is playing ⟨title⟩ — click to open."* The click is the user gesture; if the track lands paused, the toast's second state says "click play."
- **Wrong service:** `program mismatch` chip + toast; no cross-service auto-navigation.

### 8.6 Join snapshot & interaction policy

On `hello`/`welcome`, host sends epoch + snapshot; follower treats it as an epoch change (navigate → hard-sync → servo). v1 is hard host-authoritative: follower-local pause/seek is overridden within one tick (UI copy says so). Followers own only: their volume (untouched except ad-mute/restore), their offset slider, Leave.

---

## 9. Media-clock sampler (new in v1.1 — the 15 ms target lives or dies here)

`timeupdate` fires every ~15–250 ms and its dispatch is jittery: it is a *scheduling tick*, never a timestamp source. Raw `currentTime` reads quantize to frame or audio-buffer boundaries. Each adapter therefore provides a **sampler** producing:

```ts
type MediaClockSample = Readonly<{
  perfNowMs: number        // content-script performance.now() paired same-turn
  mediaTimeSec: number
  rate: number
  paused: boolean
  readyState: number
  source: "rvfc" | "edge-poll" | "coarse"
  jitterP95Ms: number      // rolling estimate from fit residuals
}>
```

**Video sampler (YouTube): `requestVideoFrameCallback`.** Each callback delivers `metadata.mediaTime` (the presented frame's media timestamp) with `metadata.expectedDisplayTime` — a media↔wall mapping with typically sub-ms jitter. Re-register per frame. rVFC is compositor-driven and **stalls in hidden tabs**: if no callback arrives for 500 ms while `!paused`, fall back to edge-poll.

**Audio sampler (Spotify) and hidden-tab fallback: edge-detected polling.** Poll `currentTime` at `POLL_HZ = 50` (foreground; falls to whatever `timeupdate` + throttled intervals give when hidden, ~1–4 Hz for audible tabs). Record a sample only on a *change edge* — the tick where `currentTime` differs from the previous read; the edge instant is aligned to the pipeline's clock update, killing most quantization error. Keep last `EDGE_WINDOW = 16` edges; robust line fit (Theil–Sen slope + median intercept) gives `mediaTimeAt(perfNow)`, measured slope (feeds the watchdog, §10.4), and `jitterP95Ms` from residuals.

**Contract:** the servo consumes only sampler output. Fine sync requires `jitterP95Ms ≤ JITTER_BUDGET_MS = 5`; above budget the effective deadband widens to `max(DEADBAND_S, 1.5 × jitterP95)` and the `locked` chip is withheld. `clockJitterP95Ms` is part of adapter capabilities (§12).

### 9.5 Rate-capability probe (per adapter, at join)

Set `preservesPitch = true`. Probe: rate 1.02 for 2 s, measure the sampler's fitted slope; accept if within ±0.005 of commanded. On failure try 1.01, then 1.005; on total failure set capability `rateTrim = 0` ⇒ coarse mode (§10.5), chip `coarse` or `unsupported`. Restore rate 1 and re-sync after. This probe is R1's runtime answer — it runs every session, so a Spotify player update changes behavior at next join, not silently mid-session.

---

## 10. Servo (content script, pure core)

### 10.1 Fine-sync preconditions

All of: `rateTrim > 0` · `jitterP95Ms ≤ 5` · summed clock uncertainty ≤ `CLOCK_UNC_MAX_MS = 5` · freshest beacon ≤ 5 s old · not buffering (either side) · activation granted. Any failure ⇒ the peer is in a degraded state (HOLD / coarse / `clock_degraded` / `needs_activation`) and the UI says which.

### 10.2 Offset sign convention & target (derivation stays in code comments)

Machine *i* with output latency `L_i`: sound heard at wall time `t` is media position `p_i(t) − L_i`. Aligning *sound* ⇒ `p_i(t) = p_host(t) + (L_i − L_host)`:

```
latencyOffset_i := L_i − L_host     // slider value, seconds; laggier output ⇒ media clock runs AHEAD
hostNow   = toHost(performance.now())
hostMedia = beacon.mediaTime + (playing && !buffering ? (hostNow − beacon.hostClock)/1000 × beacon.rate : 0)
            // extrapolation capped at EXTRAP_CAP_S = 2; older ⇒ HOLD
target    = hostMedia + latencyOffset
actual    = sampler.mediaTimeAt(performance.now())
e         = target − actual          // seconds; e > 0 ⇒ behind ⇒ speed up
```

Positive slider = "this machine's sound is late" = run ahead. One sentence, in the UI tooltip too.

### 10.3 Control law (P-only, slew-limited)

```
per tick (scheduled by timeupdate + 250 ms interval backstop; law is tick-rate independent):
  preconditions failed                        → HOLD:   rate → 1 (slew-limited), no seeks
  settling (post-seek)                        → SETTLE: rate = 1 until 'seeked' + SETTLE_MS
  epoch changed or |e| > HARD_SYNC_S (0.4)    → SEEK:   currentTime = target + seekLead; → SETTLE
  |e| ≤ deadband (10 ms, widened per §9)      → LOCKED: rate → 1
  else                                        → TRIM:   rateTarget = 1 + clamp(e / TAU_S, ±maxTrim)
  applied rate moves toward rateTarget at ≤ SLEW_PER_S = 0.02/s   // no audible steps
```

- `TAU_S = 2.0`, `maxTrim = min(0.02, probe result)`. `seekLead` = EMA of measured set-`currentTime`→`seeked` latencies, init 0.15 s.
- **Why P-only, no integral:** the only steady-state disturbance is relative clock skew (tens of ppm); `e_ss ≈ 20 ppm × 2 s = 40 µs`, three orders under the deadband. Integral adds windup risk in throttled tabs for nothing. Proportional-on-state is also what makes 1 Hz hidden-tab ticks safe.
- Host `paused`: follower pauses, one `currentTime = target` correction if off by > deadband, then idle.
- Follower `waiting` (own stall): HOLD — never trim into a stall; on `playing`, error usually exceeds HARD_SYNC ⇒ clean seek.

### 10.4 Rate watchdog (new — guards R1/R2)

Two detectors, both cheap:
1. **`ratechange` not caused by us** (adapter flags its own writes): re-assert our rate once; if external writes persist (≥ 3 in 30 s), downgrade.
2. **Slope mismatch:** while TRIM holds commanded rate `r_c`, compare the sampler's fitted slope `r_m` over 3 s; if `|r_m − r_c| > 0.5 × |r_c − 1|` for 3 consecutive checks, the element isn't obeying ⇒ re-probe once; on failure downgrade.

Downgrade path: halve `maxTrim` → if already ≤ 0.005, set `rateTrim = 0` ⇒ coarse mode. Every transition logged and surfaced as a chip change. Recovery: next session's probe (§9.5) starts fresh.

### 10.5 Coarse mode

When `rateTrim = 0` or jitter permanently over budget: every 5 s, if |e| > `MICRO_SEEK_S = 0.025`, `currentTime += e`. Audibly imperfect by design; chip `coarse`; still epoch-correct and host-authoritative. This is the guaranteed-to-work floor for any DRM/player behavior.

### 10.6 Peer state machine (unified — UI chips and logic share it)

```ts
type PeerSyncState =
  | "pairing" | "clock_warmup" | "needs_activation" | "muted_bridge"
  | "loading_program" | "program_mismatch"
  | "converging" | "locked"
  | "clock_degraded" | "buffering" | "ad_muted"
  | "coarse" | "unsupported"
  | "coasting" | "rejoinable"
```

The servo's internal states (HOLD/SETTLE/SEEK/TRIM/LOCKED) live *inside* `converging`/`locked`/degraded states; `PeerSyncState` is the peer-level machine reported upstream (§8.4) and rendered as chips.

**Activation sub-machine (explicit, per reviewer):** `needs_activation` → adapter's `play()` rejects with `NotAllowedError` → attempt **muted** playback (`muted = true; play()`), which Chrome generally permits → if that succeeds: `muted_bridge` — media clock syncs silently, toast says "click to unmute"; the click (a real user gesture in our content-script handler) unmutes → normal flow. If even muted play rejects: stay `needs_activation`, toast "click the player once." One interaction per machine per tab session, worst case; zero when the user already pressed play themselves.

---

## 11. Ads — defensive module (everyone is Premium; this is a fallback)

Detection (YouTube): MutationObserver on `#movie_player` class list for `ad-showing` / `ad-interrupting`. Spotify Premium has no ads; defensively, a now-playing item reading as an advertisement is treated as one.

**Follower hits an ad:** mute element (remember prior volume/muted), servo → HOLD, send `{t:"status", state:"ad_muted"}`. On ad end: hard-sync to current target, restore audio, resume servo. The DataChannel never drops; recovery is sub-second; no re-pairing.

**Host hits an ad:** beacons carry `adActive: true` + `ad-start` event; followers **pause and hold** (host's media has diverged — there is nothing valid to chase). Host mutes itself locally (courtesy). On `ad-end` (new epoch + snapshot): followers hard-sync and resume; host restores audio.

---

## 12. Media adapters

### 12.1 Execution-world mandate

**v1 adapters are isolated-world DOM-only.** The isolated world shares the page's DOM, so `querySelector`, `currentTime`, `playbackRate`, `muted`, and media events all work without touching page JavaScript. **MAIN-world injection is banned in v1.** If a future adapter ever needs a page bridge, it must live in a separate module, communicate only via schema-validated `postMessage`, and never expose extension APIs to page code — but that is backlog, not a v1 option.

### 12.2 Contract

```ts
type AdapterCaps = Readonly<{
  rateTrim: number            // 0 = coarse mode; set by probe §9.5, lowered by watchdog §10.4
  clockJitterP95Ms: number    // live, from sampler
  canNavigate: boolean        // YouTube true, Spotify false (toast flow)
  canDetectAd: boolean
}>

type MediaAdapter = Readonly<{
  service: Service
  element: () => Option<HTMLMediaElement>       // retry-resolving; players re-mount — never cache across navigations
  mediaId: () => Option<string>
  sampler: () => MediaClockSample               // §9
  onNavigation: (cb: () => void) => Unsubscribe
  onAdChange: (cb: (ad: boolean) => void) => Unsubscribe
  onExternalRateChange: (cb: () => void) => Unsubscribe   // watchdog input
  navigate: (mediaId: string) => void           // or trigger toast flow
  probe: () => Promise<AdapterCaps>
}>
```

**YouTube:** element `video.html5-main-video` (fallback `#movie_player video`); navigation via `yt-navigate-finish` + `location.assign`; ad classes per §11; rVFC sampler. *Known risk R2:* the player re-asserts rate on quality/format switches — watchdog handles it.

**Spotify:** element `document.querySelector("video, audio")` with retry (EME/MSE-backed; DRM blocks capture, not necessarily `currentTime`/`playbackRate` — **unproven, accepted risk R1**; the probe answers per-session); edge-poll sampler; `canNavigate: false` ⇒ toast (§8.5). If the probe fails, Spotify ships as labeled coarse mode — that outcome is acceptable for v1 by explicit decision.

**Fixture (tests only):** same interface over a locally generated video (§16) — deterministic e2e without either service.

---

## 13. Popup UI

Three screens, vanilla TS + `<template>`s (~200 lines):

- **Idle:** device-name input (persisted) · [Create room] · [Join room] + paste field · settings: LAN-only toggle.
- **Hosting:** program line · peer rows: `name · rtt · clock unc · drift e · PeerSyncState chip` (fed by §8.4 status reports) · [Add peer] → offer blob + answer paste · [End room].
- **Joined:** host name · own chip + live drift readout · **offset slider** −500…+500 ms, 1 ms steps, live-applied (storage → content `onChanged`), persisted, tooltip states the sign convention (§10.2) · [Rejoin] (only in `rejoinable`) · [Leave].

Ear-test guidance (README + a hint under the slider): host plays any steady-beat video; follower drags until the flam disappears. This is v1's acoustic alignment story; auto-calibration is backlog.

Popup renders from `roomState` pushed over its own `"ui"` port (§5.2) — opening the popup never touches the hot path, and nothing depends on SW uptime. In-page toast: one shadow-DOM component (gesture prompts, Spotify navigation).

---

## 14. Security & privacy

- **Surface:** two content-script hosts; permissions `offscreen`, `storage`; no mic (v1), no remote code, no analytics. Network = WebRTC to explicitly paired peers + one STUN request at pairing (disable-able, R5). DTLS 1.2+ by construction; nothing persists except settings.
- **Peer trust:** semi-trusted. Followers accept `beacon`/`ev` **only from the host connection**; host accepts only `hello`, `pong`, `status`, `restart-answer`, `bye` from followers. A malicious invitee can at worst disturb playback in the room that invited it.
- **Ingress validation:** every DataChannel and Port message passes hand-rolled guards (`proto.ts`, parse-don't-validate → `Result<Msg, ParseError>`); numbers finite-checked, strings length-capped, unknown `t` dropped + counted. Rate-limit inbound (sustained > 50 msg/s ⇒ drop peer). Blob caps per §6.2.
- **Identifiers:** all IDs (`roomId`, `peerId`, `instanceId`, ping ids' nonce seed) from `crypto.getRandomValues`; `peerId` is room-scoped — regenerated per room, never a persistent device identifier. `name` sanitized (≤ 24 chars, control chars stripped) and rendered via `textContent` only.
- **Blob = bearer token**, single-use, 10 min TTL. `protoVersion` in `hello`; mismatch ⇒ reject with reason.

---

## 15. Resilience & edge cases

| Case | Behavior |
|---|---|
| Hidden tab | Audible tabs keep `timeupdate` ticking (~1–4 Hz) and are exempt from intensive throttling; rVFC stalls ⇒ sampler falls back to edge-poll; jitter rises ⇒ adaptive deadband (§9). P-law is tick-rate independent. **AC: p95 drift ≤ 25 ms with follower tab hidden.** |
| Sleep / lid close | `performance.now()` may halt during sleep. Ping-gap > 3 s ⇒ clock `stale` ⇒ HOLD ⇒ warmup burst ⇒ hard-sync if needed. **AC: re-locked ≤ 5 s after wake.** |
| Wi-Fi wobble | §6.4: COASTING grace → host-only `restartIce()` while control still flows → else `rejoinable`. Followers coast blind ≤ 10 s (drift ≈ skew only). |
| Offscreen document killed | §5.4: ports drop ⇒ content pings SW ⇒ `getContexts` ⇒ recreate ⇒ `rejoinable`, one-blob re-pair. Never a zombie session. |
| Tab navigation / player remount | Offscreen connection unaffected; content re-registers, media port re-handshakes (`mediaHello`, new `instanceId`), local clock re-warms, servo resumes. Adapters re-resolve `element()` on demand. |
| Host tab closes | Beacons stop ⇒ followers HOLD + `coasting` chip after 5 s; host reopening the program resumes (offscreen kept the peers). Explicit End room sends `bye` + closes offscreen. |
| Host buffering | `buffering: true` in beacons ⇒ followers HOLD (extrapolating a stalled clock is chasing fiction). Host recovery ⇒ `seek` event + epoch bump ⇒ clean resync. |
| Follower buffering | `waiting` ⇒ HOLD; `playing` ⇒ usually a clean hard-seek. |
| Internet-path clock (R4) | Summed uncertainty > 5 ms ⇒ `clock_degraded`, fine sync withheld, gate never widened. |
| No direct path at all | §6.5 failure UX: named states + hotspot script. |
| Program mismatch / wrong service | §8.5. |

---

## 16. Repository, coding standards, testing

### 16.1 Layout & tooling

```
manifest.json
src/
  sw.ts                     # offscreen lifecycle + tab election, nothing else
  offscreen/{offscreen.html, offscreen.ts, peerhub.ts, blob.ts}
  content/{content.ts, sampler.ts, servo.ts, adapter.ts, youtube.ts, spotify.ts, toast.ts}
  popup/{popup.html, popup.ts}
  lib/{clock.ts, proto.ts, cal_math.ts?×(backlog), types.ts, constants.ts}   # pure, no chrome.* imports
tests/
  unit/        # vitest: clock filter, servo law, sampler fit, blob roundtrip+caps, proto fuzz
  sim/         # two virtual peers, virtual clocks with skew/jitter — pure, no browser
  e2e/         # playwright: two persistent contexts + fixture adapter
  fixtures/media.html
package.json   # scripts: build (esbuild), test, sim, e2e
```

- **TypeScript strict. Zero runtime dependencies.** Dev deps: esbuild, vitest, playwright only.
- **Conventions (mandatory):** discriminated unions for every protocol message and every state machine (`Wire`, `PortMsg`, `PeerSyncState`, servo states, connection states) with `assertNever` exhaustiveness; `Option`/`Result` at module boundaries instead of null/throw; `Readonly<>` inputs, RO-RO signatures; **branded units** — `Ms`, `Sec`, `HostClockMs`, `ContentClockMs`, `MediaSec` are distinct branded number types. Clock-domain and unit mix-ups are *the* bug class in this codebase; make them uncompilable.
- **Parse, don't validate** at every ingress: DataChannel, Port, storage reads, blobs.
- **Pure core, effectful shell:** `lib/*`, the servo law, the sampler fit, and the clock filter are pure functions — values in, values out, fully unit-testable without a browser. `chrome.*`, DOM, and RTC live only in shell files.
- **Discipline:** smallest working solution per milestone; no abstraction before the third use (there are exactly two adapters — resist an adapter framework); every line justifies its existence; a module you can't describe in one sentence without "and" is two modules. When something breaks: exact error, logged values, minimal fix.

### 16.2 Testing

- **Unit (CI):** clock filter properties (offset recovery under asymmetric jitter; stale triggers); sampler fit (edge quantization removal; jitter estimation on synthetic quantized clocks); servo law table-tests (every state × error band × precondition combination); convergence sim (100 ms initial error → locked < 6 s, no deadband oscillation, slew respected); blob roundtrip incl. cap enforcement and bomb rejection; proto parser fuzz (garbage never throws, always `Err`).
- **Sim (CI):** two virtual peers, virtual clocks with ±50 ppm skew and 0–10 ms message jitter: p95 model error ≤ 15 ms; ≤ 25 ms at 1 Hz ticks; watchdog downgrade fires when the virtual element disobeys rate.
- **E2E (local, headed):** Playwright, two `launchPersistentContext`s with `--load-extension`, fixture page + Fixture adapter. Fixture media generated at test setup by recording a 60 s canvas+oscillator stream via `MediaRecorder` to a blob URL (seekable, rate-adjustable, no binary assets in repo). Scripted flow: pair via programmatic blob hand-off → play → assert drift → seek → epoch resync → toggle fake ad class → mute/HOLD/recover → kill offscreen doc → assert `rejoinable` surfaced → re-pair.
- **Manual matrix (two real MacBooks, README checklist):** same Wi-Fi pair/sync · different networks (hotspot vs home — STUN path) · AP-isolated Wi-Fi (expect srflx rescue or the scripted failure message) · LAN-only mode on shared Wi-Fi · hidden tab · lid close/open · Bluetooth speaker + ear-test slider alignment · Spotify probe outcome recorded (either result acceptable, R1) · external `playbackRate` interference via DevTools → watchdog downgrade visible.

---

## 17. Milestones & acceptance criteria (ship strictly in order)

**M0 — Scaffold.** Manifest (`minimum_chrome_version: 116`), build, four contexts wired, envelope routing, media-port handshake + backoff, offscreen lifecycle via `getContexts`. ✅ Loadable unpacked; unit green; manually killing the offscreen doc triggers the recreate path.

**M1 — Pairing + clock.** Raw-SDP blob codec with caps, add-peer/join flows, STUN-default + LAN-only toggle, three channels, both clock hops, popup readouts over the `"ui"` port. ✅ Two Chrome profiles, one machine: offset MAD ≤ 0.5 ms over 60 s. ✅ Two real machines on *different* networks pair via STUN. ✅ Offscreen kill ⇒ `rejoinable` in popup ⇒ one-blob re-pair works.

**M2 — YouTube sync MVP.** rVFC sampler (+edge-poll fallback), servo with slew + watchdog, epochs, join snapshot, activation machine incl. muted bridge, navigation follow, offset slider end-to-end. ✅ p95 |e| ≤ 15 ms after 30 s settle (two profiles). ✅ Host play/pause/seek applied on follower ≤ 500 ms (command receipt and application measured separately from audible convergence). ✅ DevTools-forced external `ratechange` ⇒ re-assert, then downgrade on persistence, chip updates. ✅ Slider audibly shifts alignment in 1 ms steps and persists.

**M3 — Spotify adapter (R1 decision point).** Element resolution with retry, edge-poll sampler, probe, coarse fallback, toast navigation. ✅ Probe outcome surfaced in UI; **both outcomes ship:** probe passes ⇒ M2 drift AC holds on Spotify; probe fails ⇒ `coarse`/`unsupported` engaged and labeled, seek-sync still epoch-correct. Record findings in README for the deferred elaboration.

**M4 — Ads defense + election + status.** Both ad state machines; controlled-tab election with explicit pushes; follower status reports feeding host chips. ✅ Toggling `ad-showing` on a follower ⇒ mute+HOLD, resync ≤ 1 s after removal. ✅ Host-ad ⇒ followers pause, resume on ad-end epoch. ✅ Second same-service tab never runs a servo.

**M5 — Resilience polish.** Hidden-tab AC (≤ 25 ms p95), sleep/wake re-lock ≤ 5 s, COASTING → restart → `rejoinable` drill on real Wi-Fi toggling, host-tab close/reopen, README (accepted risks R1–R5, privacy note, ear-test guide, hotspot script, manual matrix).

---

## 18. Appendix A — Constants (`lib/constants.ts`; every tunable lives here)

| Name | Value | Meaning |
|---|---|---|
| `PING_HZ` / `WARMUP_PINGS` | 1 / 8 @ 4 Hz | clock pings; burst on open/wake |
| `WINDOW` / `RTT_GATE_MS` | 32 / 2 | clock filter window; relative RTT gate |
| `CLOCK_UNC_MAX_MS` | 5 | summed MAD above ⇒ `clock_degraded` (never widened, R4) |
| `JITTER_BUDGET_MS` | 5 | sampler p95 above ⇒ widened deadband, no `locked` chip |
| `BEACON_HZ` / `BEACON_MAX_AGE_S` | 3 / 5 | host beacon rate; staleness ⇒ HOLD |
| `EXTRAP_CAP_S` | 2 | max beacon extrapolation |
| `DEADBAND_S` | 0.010 | base deadband (adaptive: max(this, 1.5×jitter)) |
| `TAU_S` / `MAX_TRIM` / `SLEW_PER_S` | 2.0 / 0.02 / 0.02 | P-law constant; trim clamp (probe/watchdog may lower); rate slew |
| `HARD_SYNC_S` / `SETTLE_MS` | 0.40 / 250 | seek threshold; post-`seeked` hold |
| `MICRO_SEEK_S` / period | 0.025 / 5 s | coarse mode |
| `POLL_HZ` / `EDGE_WINDOW` | 50 / 16 | edge-poll sampler |
| `WATCHDOG_FIT_S` | 3 | slope-mismatch window |
| `GRACE_S` / `RESTART_TIMEOUT_S` | 10 / 10 | coasting grace; in-band restart timeout |
| `PORT_BACKOFF` | 250 ms → 4 s ×2 | media-port reconnect |
| `BLOB_TTL_S` | 600 | invite/answer validity |
| `BLOB_MAX_ENC / MAX_JSON / MAX_SDP` | 6 000 / 20 480 / 16 384 | codec caps (chars/bytes) |
| `STUN_URL` | `stun:stun.l.google.com:19302` | default; `[]` in LAN-only mode |
| `MAX_PEERS` | 7 | followers per room |
| `OFFSET_SLIDER` | ±500 ms, 1 ms | manual acoustic trim |

## 19. Appendix B — Wire & port schemas (normative)

```ts
type Service = "youtube" | "spotify"
type Program = Readonly<{ service: Service; mediaId: string }>
type Snap = Readonly<{ program: Program; mediaTime: number; hostClock: number;
                       rate: number; playing: boolean; buffering: boolean; adActive: boolean }>

// ---- DataChannel messages (JSON, one object per message) ----
type Wire =
  | Readonly<{ t: "hello"; protoVersion: 1; peerId: string; name: string }>
  | Readonly<{ t: "welcome"; roomId: string; hostName: string; epoch: number; snap: Snap }>
  | Readonly<{ t: "ping"; id: number; t0: number }>
  | Readonly<{ t: "pong"; id: number; t0: number; t1: number; t2: number }>
  | Beacon                                                                     // §8.2
  | Readonly<{ t: "ev"; epoch: number; kind: "play" | "pause" | "seek" | "program" | "ad-start" | "ad-end"; snap: Snap }>
  | Readonly<{ t: "status"; state: PeerSyncState; eMs: number; jitterMs: number }>   // follower → host
  | Readonly<{ t: "restart-offer"; blob: string }>                             // host → follower only
  | Readonly<{ t: "restart-answer"; blob: string }>
  | Readonly<{ t: "bye" }>

// ---- Content ↔ Offscreen "media" port ----
type PortMsg =
  | Readonly<{ t: "mediaHello"; proto: 1; instanceId: string; service: Service;
               mediaId: string | null; adapterVersion: string }>               // MUST be first
  | Readonly<{ t: "controlled"; on: boolean }>                                 // sw/offscreen → content
  | Readonly<{ t: "ping" | "pong" /* same fields as Wire */ }>
  | Readonly<{ t: "clock-map"; hostOffsetMs: number; uncMs: number; locked: boolean }>
  | Readonly<{ t: "sample"; snapLocal: Snap /* hostClock field = content-clock ts */ }>   // host content → offscreen
  | Readonly<{ t: "beacon-relay"; beacon: Beacon }>                            // follower offscreen → content
  | Readonly<{ t: "ev-relay"; ev: Extract<Wire, { t: "ev" }> }>
  | Readonly<{ t: "media-ev"; kind: "seeked" | "play" | "pause" | "waiting" | "playing"
                             | "nav" | "ad" | "external-ratechange"; ad?: boolean }>
  | Readonly<{ t: "state-report"; state: PeerSyncState; eMs: number; jitterMs: number }>  // content → offscreen → host
  | Readonly<{ t: "gesture-needed" }>

// ---- Popup ↔ Offscreen "ui" port ----
// offscreen → popup: { t: "roomState", ... } on change + 1 Hz while port open
// popup → offscreen: { t: "createRoom", name, lanOnly } | { t: "addPeer" } | { t: "join", blob, name, lanOnly }
//                    | { t: "acceptAnswer", blob } | { t: "leave" } | { t: "endRoom" }
```

All ingress parsed by hand-written guards returning `Result<…, ParseError>`; numbers finite-checked; strings length-capped; unknown `t` dropped and counted.

## 20. Appendix C — Blob codec (normative)

1. Build `PairBlob` (§6.2) with `sdp = pc.localDescription.sdp` after `iceGatheringState === "complete"`.
2. `JSON.stringify → new CompressionStream("deflate-raw") → base64url` (no padding).
3. Decode: length check (≤ `BLOB_MAX_ENC`) → base64url → `DecompressionStream("deflate-raw")` with output cap `BLOB_MAX_JSON` (abort stream on overflow) → `JSON.parse` → schema guard → `v`/TTL/`sdp`-length checks → `setRemoteDescription({ type: kind, sdp })`.
4. Golden tests: encode/decode roundtrip; oversized-input rejection; truncated-input rejection; a stored known-good Chrome SDP fixture must survive roundtrip byte-identical.

*(v1.0's minimized-SDP template is deferred — see §21. If revived: `sdpTemplateVersion` + `chromeMajor` fields, golden tests against Stable/Beta/Canary, strict per-candidate validation.)*

## 21. Backlog (design preserved, explicitly out of v1)

**B1 — Acoustic auto-calibration** *(removed from v1 by decision; manual slider + ear test ship instead).* Design summary so nothing is lost: host schedules a window at hostClock `T`; machine *k* plays a Hann-windowed 2.5→6.5 kHz, 120 ms chirp at `s_k = T + k·750 ms` from its **content script** WebAudio (same output path as the media element, inherits tab activation); every machine records the whole window via `getUserMedia` in **offscreen** (`echoCancellation/noiseSuppression/autoGainControl: false`) and matched-filters arrivals `a_{j,k}` (mapped to hostClock, minus `s_k`). With `δ_k` = k's emission lateness, `i_j` = j's input latency, `prop` = acoustic flight: `a_{j,k} = δ_k + prop_{jk} + i_j`, so `d_{j,k} = a_{j,k} − a_{j,0} = (δ_k − δ_0) + (prop_{jk} − prop_{j0})` — input latency cancels; `latencyOffset_k ≈ mean_{j≠k} d_{j,k}` shrinks the geometry term (sound ≈ 2.9 ms/m — irreducible per-listener). Re-adding requires: manifest reason `USER_MEDIA`, mic permission UX (extension-origin grant + macOS OS-level), `cal-start/cal-report/cal-result` wire messages, pure `cal_math.ts`, an acoustic acceptance test at a defined listening position (p95 arrival error ≤ 15 ms post-settle), and the honest caveat that the WebAudio chirp path and the media-element path can differ by a few ms — the slider stays as fine trim regardless.

**B2 — Swift Bonjour helper (zero-touch discovery).** ~100-line menu-bar app: `NWListener`/`NWBrowser` advertising `_chorus._tcp`, shuttling the two pairing blobs over one LAN TCP round-trip, talking to the extension via native messaging (stdio). All media/state traffic stays on the same DTLS WebRTC channels — the helper's attack surface is discovery only. Needs signing/notarization + a native-messaging host manifest. Revisit after M5 if the one-AirDrop-per-session ritual proves annoying.

**B3 — Spotify fine-rate elaboration (R1).** Deferred by decision. When picked up: characterize `playbackRate` behavior on `open.spotify.com` Premium across track changes, quality switches, background tabs, device-transfer events, and 30-min sustained trims; decide fine-sync support or invest in a gentler coarse mode (smaller, more frequent nudges). M3 README findings are the input.

**B4 — Minimized-SDP blobs** (shorter invites; QR-friendlier) behind golden tests — see Appendix C note. **B5 — QR and audio-modem couriers.** **B6 — TURN/WAN rooms** (would need infrastructure — contradicts G2; only if the product ever leaves the room). **B7 — Degraded-sync band for internet paths (R4)** once real jitter data exists. **B8 — MAIN-world adapter bridge**, only if DOM-only provably fails on some future player.

## 22. Open questions (non-blocking)

- Popup vs. injected on-page control strip for day-to-day status — decide after M2 dogfood.
- Should follower volume dip slightly during TRIM > 1 %? Probably imperceptible either way — test by ear at M2.
- Chip taxonomy: is `coasting` vs `rejoinable` distinction clear to non-technical users? Copy review at M5.

---

*End of spec v1.1.*
