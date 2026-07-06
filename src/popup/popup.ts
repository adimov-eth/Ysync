// Popup: room lifecycle UI over its own "ui" port to the offscreen document.
// No protocol logic here (§5.1); renders pushed roomState, writes settings
// to chrome.storage. Nothing depends on SW uptime beyond ensure-offscreen.

import type { RoomState } from "../offscreen/peerhub.js"
import { runtimeSendMessage, storageLocalGet, storageLocalSet } from "../lib/ext.js"

type UiPush =
  | { t: "roomState"; state: RoomState }
  | { t: "answerBlob"; blob: string }
  | { t: "error"; reason: string }

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id)
  if (el === null) throw new Error(`missing #${id}`)
  return el as T
}

let port: chrome.runtime.Port | null = null
let latest: RoomState | null = null

const sendUi = (msg: unknown): void => {
  try {
    port?.postMessage(msg)
  } catch {
    setError("Lost connection to the extension — reopen the popup.")
  }
}

const setError = (text: string): void => {
  for (const id of ["idle-error", "host-error", "joined-error"]) $(id).textContent = text
}

// ---- settings ----

const deviceName = $<HTMLInputElement>("device-name")
const lanOnly = $<HTMLInputElement>("lan-only")
const offsetSlider = $<HTMLInputElement>("offset-slider")
const offsetValue = $("offset-value")

void storageLocalGet(["deviceName", "lanOnly", "offsetMs"]).then((got) => {
  if (typeof got["deviceName"] === "string") deviceName.value = got["deviceName"]
  if (typeof got["lanOnly"] === "boolean") lanOnly.checked = got["lanOnly"]
  if (typeof got["offsetMs"] === "number") {
    offsetSlider.value = String(got["offsetMs"])
    offsetValue.textContent = `${got["offsetMs"]} ms`
  }
})

deviceName.addEventListener("change", () => {
  void storageLocalSet({ deviceName: deviceName.value.slice(0, 24) })
})
lanOnly.addEventListener("change", () => {
  void storageLocalSet({ lanOnly: lanOnly.checked })
})
offsetSlider.addEventListener("input", () => {
  const v = Number(offsetSlider.value)
  offsetValue.textContent = `${v} ms`
  // Live-applied: content script listens via storage.onChanged (§13).
  void storageLocalSet({ offsetMs: v })
})

// ---- render ----

const show = (screen: "idle" | "hosting" | "joined"): void => {
  for (const s of ["idle", "hosting", "joined"]) {
    $(`screen-${s}`).classList.toggle("active", s === screen)
  }
}

const chipClass = (state: string): string =>
  state === "locked" ? "chip locked" : state === "rejoinable" || state === "unsupported" ? "chip bad" : "chip"

const render = (s: RoomState): void => {
  latest = s
  if (s.phase === "idle") {
    show("idle")
  } else if (s.phase === "hosting") {
    show("hosting")
    $("host-room").textContent = s.roomId ?? ""
    $("host-program").textContent =
      s.program === null ? "Play something — the room follows this machine." : `${s.program.service}: ${s.program.mediaId}`
    const list = $("peer-list")
    list.textContent = ""
    for (const p of s.peers) {
      const row = document.createElement("div")
      row.className = "peer"
      const name = document.createElement("span")
      name.textContent = p.name // textContent only — never markup (§14)
      const meta = document.createElement("span")
      meta.className = "muted"
      const rtt = typeof p.rttMs === "number" && Number.isFinite(p.rttMs) ? ` ${p.rttMs.toFixed(0)}ms` : ""
      const drift = p.status === null ? "" : ` e=${p.status.eMs}ms`
      meta.textContent = `${rtt}${drift} `
      const chip = document.createElement("span")
      chip.className = chipClass(p.status?.state ?? p.connState)
      chip.textContent = p.status?.state ?? p.connState
      meta.appendChild(chip)
      row.append(name, meta)
      list.appendChild(row)
    }
    const offerArea = $("offer-area")
    if (s.pendingOfferBlob !== null) {
      offerArea.style.display = ""
      $<HTMLTextAreaElement>("offer-blob").value = s.pendingOfferBlob
    } else {
      offerArea.style.display = "none"
      $<HTMLTextAreaElement>("paste-answer").value = ""
    }
    if (s.lastError !== null) $("host-error").textContent = s.lastError
  } else {
    show("joined")
    $("joined-host").textContent = s.hostName ?? ""
    const self = s.peers[0]
    const chip = $("self-chip")
    const state = self?.status?.state ?? (s.conn === "rejoinable" ? "rejoinable" : "pairing")
    chip.className = chipClass(state)
    chip.textContent = state
    // Belt and braces: port JSON-serialization maps non-finite numbers to
    // null, so never trust numeric fields to be numbers here.
    const clock = s.clock
    $("self-drift").textContent =
      clock !== null && typeof clock.uncMs === "number" && Number.isFinite(clock.uncMs)
        ? `clock ±${clock.uncMs.toFixed(1)} ms${clock.locked ? "" : " (warming)"}`
        : "clock warming…"
    $("rejoin-area").style.display = s.conn === "rejoinable" ? "" : "none"
    if (s.conn === "connected") $("joined-answer-area").style.display = "none"
  }
}

// ---- wire buttons ----

$("btn-create").addEventListener("click", () => {
  sendUi({ t: "createRoom", name: deviceName.value || "Mac", lanOnly: lanOnly.checked })
})

$("btn-join").addEventListener("click", () => {
  const area = $("join-area")
  area.style.display = area.style.display === "none" ? "" : "none"
})

$("btn-join-go").addEventListener("click", () => {
  setError("")
  sendUi({
    t: "join",
    blob: $<HTMLTextAreaElement>("join-blob").value.trim(),
    name: deviceName.value || "Mac",
    lanOnly: lanOnly.checked,
  })
  $("join-hint").textContent = "Generating answer…"
})

$("btn-add-peer").addEventListener("click", () => {
  setError("")
  sendUi({ t: "addPeer" })
})

$("btn-copy-offer").addEventListener("click", () => {
  void navigator.clipboard.writeText($<HTMLTextAreaElement>("offer-blob").value)
})

$("btn-accept-answer").addEventListener("click", () => {
  setError("")
  sendUi({ t: "acceptAnswer", blob: $<HTMLTextAreaElement>("paste-answer").value.trim() })
})

$("btn-end").addEventListener("click", () => sendUi({ t: "endRoom" }))
$("btn-leave").addEventListener("click", () => sendUi({ t: "leave" }))

$("btn-rejoin").addEventListener("click", () => {
  setError("")
  sendUi({
    t: "join",
    blob: $<HTMLTextAreaElement>("rejoin-blob").value.trim(),
    name: deviceName.value || "Mac",
    lanOnly: lanOnly.checked,
  })
})

// ---- connect ----

const onPush = (raw: unknown): void => {
  const msg = raw as UiPush
  if (msg.t === "roomState") {
    // A render throw must not wedge the popup for every later push.
    try {
      render(msg.state)
    } catch (e) {
      console.warn("[chorus] popup render failed", e)
    }
  } else if (msg.t === "answerBlob") {
    // join() lands us on the joined screen before the blob arrives — the
    // answer must be visible THERE, or the user can never deliver it.
    $("joined-answer-area").style.display = ""
    $<HTMLTextAreaElement>("joined-answer").value = msg.blob
    void navigator.clipboard.writeText(msg.blob).catch(() => undefined)
  } else if (msg.t === "error") {
    setError(msg.reason)
    $("join-hint").textContent = ""
  }
}

const connect = async (): Promise<void> => {
  // Make sure the offscreen document exists before dialing it (§5.4).
  await runtimeSendMessage({ target: "sw", msg: { t: "need-offscreen" } }).catch(() => undefined)
  port = chrome.runtime.connect({ name: "ui" })
  port.onMessage.addListener(onPush)
  port.onDisconnect.addListener(() => {
    port = null
    setTimeout(() => void connect(), 300)
  })
}

show("idle")
void connect()
