import type { MediaAdapter } from "./adapter.js"

const AD_CLASSES = ["ad-showing", "ad-interrupting"]

const moviePlayer = (): Element | null => document.querySelector("#movie_player")

const isAdShowing = (): boolean => {
  const p = moviePlayer()
  return p !== null && AD_CLASSES.some((c) => p.classList.contains(c))
}

export const youtubeAdapter = (): MediaAdapter => ({
  service: "youtube",
  adapterVersion: "yt-1",
  element: () =>
    document.querySelector<HTMLVideoElement>("video.html5-main-video") ??
    document.querySelector<HTMLVideoElement>("#movie_player video"),
  mediaId: () => {
    if (location.pathname !== "/watch") return null
    return new URLSearchParams(location.search).get("v")
  },
  canNavigate: true,
  canDetectAd: true,
  adActive: isAdShowing,
  onNavigation: (cb) => {
    // YouTube is an SPA; it fires this on every in-app navigation.
    const handler = (): void => cb()
    document.addEventListener("yt-navigate-finish", handler)
    return () => document.removeEventListener("yt-navigate-finish", handler)
  },
  onAdChange: (cb) => {
    let last = isAdShowing()
    const observer = new MutationObserver(() => {
      const now = isAdShowing()
      if (now !== last) {
        last = now
        cb(now)
      }
    })
    const attach = (): boolean => {
      const p = moviePlayer()
      if (p === null) return false
      observer.observe(p, { attributes: true, attributeFilter: ["class"] })
      return true
    }
    if (!attach()) {
      // Player not mounted yet; retry until it is.
      const retry = setInterval(() => {
        if (attach()) clearInterval(retry)
      }, 1000)
      return () => {
        clearInterval(retry)
        observer.disconnect()
      }
    }
    return () => observer.disconnect()
  },
  navigate: (mediaId) => {
    // Full navigation on purpose: reloads the content script cleanly (§8.5).
    location.assign(`https://www.youtube.com/watch?v=${encodeURIComponent(mediaId)}`)
  },
})
