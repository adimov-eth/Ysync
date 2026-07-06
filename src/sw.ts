// Service worker: offscreen lifecycle + controlled-tab election. Nothing else.
// The SW is ephemeral — all state it needs across restarts lives in
// chrome.storage.session (survives SW termination, cleared on browser exit).
// It holds no sockets, no room state, no timers that matter.

import {
  closeOffscreenDocument,
  createOffscreenDocument,
  offscreenReasonWebRtc,
  runtimeGetContexts,
  scriptingExecuteScript,
  storageSessionGet,
  storageSessionSet,
  tabsQuery,
  tabsSendMessage,
} from "./lib/ext.js"
import { parseSwMsg } from "./lib/proto.js"
import type { Program, Service } from "./lib/types.js"

type TabReg = Readonly<{
  service: Service
  mediaId: string | null
  audible: boolean
  seq: number // registration order — monotonic, for most-recent preference
}>

type SessionState = Readonly<{
  registry: Record<string, TabReg> // key: String(tabId)
  program: Program | null
  roomActive: boolean
  regSeq: number
  controlledTabId: number | null
}>

const EMPTY: SessionState = {
  registry: {},
  program: null,
  roomActive: false,
  regSeq: 0,
  controlledTabId: null,
}

const loadState = async (): Promise<SessionState> => {
  const got = await storageSessionGet("state")
  const s = got["state"] as SessionState | undefined
  return s ?? EMPTY
}

const saveState = async (s: SessionState): Promise<void> => {
  await storageSessionSet({ state: s })
}

const MEDIA_TAB_URLS = ["https://www.youtube.com/*", "https://open.spotify.com/*"]

const injectContentIntoOpenMediaTabs = async (): Promise<void> => {
  const tabs = await tabsQuery({ url: MEDIA_TAB_URLS })
  await Promise.all(tabs.map(async (tab) => {
    if (tab.id === undefined) return
    try {
      await scriptingExecuteScript({ target: { tabId: tab.id }, files: ["content.js"] })
    } catch (e) {
      // Best-effort bootstrap for tabs that existed before install/reload.
      // Static content_scripts still cover ordinary future page loads.
      console.warn("[chorus] content bootstrap failed", tab.id, e)
    }
  }))
}

// ---- Offscreen lifecycle (§5.4) ----

let creatingOffscreen: Promise<void> | null = null

const ensureOffscreen = async (): Promise<void> => {
  const reason = offscreenReasonWebRtc()
  if (reason === null) return

  const contexts = await runtimeGetContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
  })
  if (contexts.length > 0) return
  if (creatingOffscreen === null) {
    creatingOffscreen = createOffscreenDocument({
        url: "offscreen.html",
        reasons: [reason],
        justification:
          "Holds peer-to-peer WebRTC connections for playback sync; must outlive the ephemeral service worker.",
      })
      .catch((e: unknown) => {
        // Racing a concurrent create is fine; anything else is worth a log.
        console.warn("[chorus] offscreen create failed", e)
      })
      .finally(() => {
        creatingOffscreen = null
      })
  }
  await creatingOffscreen
}

const closeOffscreen = async (): Promise<void> => {
  if (offscreenReasonWebRtc() === null) return
  const contexts = await runtimeGetContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
  })
  if (contexts.length > 0) await closeOffscreenDocument()
}

// ---- Controlled-tab election (§5.3) ----

const pickControlled = (s: SessionState): number | null => {
  const entries = Object.entries(s.registry).map(([k, v]) => ({ tabId: Number(k), reg: v }))
  if (entries.length === 0) return null

  // With a program: exact program match beats service match beats nothing.
  // Within a tier: audible beats silent, then most recently registered.
  const score = (e: { reg: TabReg }): number => {
    let n = 0
    if (s.program !== null) {
      if (e.reg.service === s.program.service) {
        n += 100
        if (e.reg.mediaId === s.program.mediaId) n += 100
      }
    }
    if (e.reg.audible) n += 10
    return n
  }
  entries.sort((a, b) => score(b) - score(a) || b.reg.seq - a.reg.seq)
  const best = entries[0]
  if (best === undefined) return null
  // Without a program (host pre-play bootstrap), any media tab qualifies;
  // with a program, require at least a service match.
  if (s.program !== null && best.reg.service !== s.program.service) return null
  return best.tabId
}

const pushControlled = async (tabId: number, on: boolean): Promise<void> => {
  try {
    await tabsSendMessage(tabId, { target: "content", msg: { t: "controlled", on } })
  } catch {
    // Tab gone or content script not ready; onRemoved / re-register will fix it.
  }
}

const runElection = async (s: SessionState): Promise<SessionState> => {
  const next = pickControlled(s)
  if (next !== s.controlledTabId && s.controlledTabId !== null) {
    await pushControlled(s.controlledTabId, false)
  }
  if (next !== null) await pushControlled(next, true)
  const out = { ...s, controlledTabId: next }
  await saveState(out)
  return out
}

// ---- Message routing ----

const handleSwMsg = async (rawMsg: unknown, sender: chrome.runtime.MessageSender): Promise<boolean> => {
  const parsed = parseSwMsg(rawMsg)
  if (!parsed.ok) {
    console.warn("[chorus] sw: dropped message:", parsed.error.reason)
    return false
  }
  const msg = parsed.value
  let s = await loadState()

  switch (msg.t) {
    case "register": {
      const tabId = sender.tab?.id
      if (tabId === undefined) break
      const regSeq = s.regSeq + 1
      s = {
        ...s,
        regSeq,
        registry: {
          ...s.registry,
          [String(tabId)]: {
            service: msg.service,
            mediaId: msg.mediaId,
            audible: msg.audible,
            seq: regSeq,
          },
        },
      }
      s = await runElection(s)
      break
    }
    case "unregister": {
      const tabId = sender.tab?.id
      if (tabId === undefined) break
      const registry = { ...s.registry }
      delete registry[String(tabId)]
      s = await runElection({ ...s, registry })
      break
    }
    case "need-offscreen": {
      // Extension-origin senders (the popup, even when opened as a tab):
      // always — the user is about to interact. Content scripts: only
      // while a room is active (§5.4), so a dropped port on an idle
      // machine doesn't resurrect the document.
      const fromUi = sender.url?.startsWith(chrome.runtime.getURL("")) === true
      if (fromUi || s.roomActive) {
        await ensureOffscreen()
        await injectContentIntoOpenMediaTabs()
      }
      break
    }
    case "program-changed": {
      s = await runElection({ ...s, program: msg.program })
      break
    }
    case "room-active": {
      s = { ...s, roomActive: msg.active }
      await saveState(s)
      if (msg.active) {
        await ensureOffscreen()
        await injectContentIntoOpenMediaTabs()
      } else {
        await closeOffscreen()
        s = await runElection({ ...s, program: null })
      }
      break
    }
    default:
      break
  }
  return true
}

const sameContextBridge = globalThis as typeof globalThis & {
  __chorusHandleSwMessage?: (msg: unknown) => Promise<boolean>
}
sameContextBridge.__chorusHandleSwMessage = async (msg: unknown): Promise<boolean> =>
  await handleSwMsg(msg, { url: chrome.runtime.getURL("") } as chrome.runtime.MessageSender)

chrome.runtime.onMessage.addListener((raw: unknown, sender, sendResponse) => {
  const envelope = raw as { target?: string; msg?: unknown }
  if (envelope?.target !== "sw") return false

  void handleSwMsg(envelope.msg, sender)
    .then((ok) => sendResponse({ ok }))
    .catch((e: unknown) => {
      console.warn("[chorus] sw: message failed", e)
      sendResponse({ ok: false })
    })
  return true // async sendResponse
})

chrome.tabs.onRemoved.addListener((tabId) => {
  void (async () => {
    const s = await loadState()
    if (s.registry[String(tabId)] === undefined) return
    const registry = { ...s.registry }
    delete registry[String(tabId)]
    await runElection({ ...s, registry, controlledTabId: s.controlledTabId === tabId ? null : s.controlledTabId })
  })()
})
