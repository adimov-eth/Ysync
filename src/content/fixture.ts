// Fixture adapter (tests only, §12.2): same interface over a locally served
// media element. Only reachable via the dev/e2e build's manifest — the
// production manifest never matches localhost.

import type { MediaAdapter } from "./adapter.js"

export const fixtureAdapter = (): MediaAdapter => ({
  service: "fixture",
  adapterVersion: "fx-1",
  element: () => document.querySelector<HTMLMediaElement>("#chorus-media"),
  mediaId: () => document.querySelector("#chorus-media")?.getAttribute("data-media-id") ?? null,
  canNavigate: true,
  canDetectAd: true,
  adActive: () => document.querySelector("#chorus-media")?.classList.contains("ad-showing") === true,
  onNavigation: () => () => undefined,
  onAdChange: (cb) => {
    const el = document.querySelector("#chorus-media")
    if (el === null) return () => undefined
    let last = el.classList.contains("ad-showing")
    const observer = new MutationObserver(() => {
      const now = el.classList.contains("ad-showing")
      if (now !== last) {
        last = now
        cb(now)
      }
    })
    observer.observe(el, { attributes: true, attributeFilter: ["class"] })
    return () => observer.disconnect()
  },
  navigate: (mediaId) => {
    document.querySelector("#chorus-media")?.setAttribute("data-media-id", mediaId)
  },
})
