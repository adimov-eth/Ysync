import type { MediaAdapter } from "./adapter.js"

// Spotify web player: EME/MSE-backed element. DRM blocks capture, not
// necessarily currentTime/playbackRate — unproven, accepted risk R1; the
// rate probe (§9.5) answers per-session and coarse mode is the floor.

const trackIdFromNowPlaying = (): string | null => {
  // Now-playing bar links the current track as /track/{id}.
  const anchor = document.querySelector<HTMLAnchorElement>(
    'footer a[href*="/track/"], [data-testid="now-playing-widget"] a[href*="/track/"]',
  )
  const href = anchor?.getAttribute("href")
  if (href == null) return null
  const m = /\/track\/([a-zA-Z0-9]+)/.exec(href)
  return m?.[1] ?? null
}

export const spotifyAdapter = (): MediaAdapter => ({
  service: "spotify",
  adapterVersion: "sp-1",
  element: () => document.querySelector<HTMLMediaElement>("video, audio"),
  mediaId: trackIdFromNowPlaying,
  canNavigate: false, // programmatic navigation + autoplay unreliable under DRM/gesture rules (§8.5)
  canDetectAd: true,
  adActive: () => {
    // Premium has no ads; defensively treat an advertisement now-playing item as one (§11).
    const widget = document.querySelector('[data-testid="now-playing-widget"]')
    return widget?.querySelector('a[href*="/track/"]') === null && widget !== null &&
      (widget.textContent ?? "").toLowerCase().includes("advertisement")
  },
  onNavigation: (cb) => {
    // SPA — watch the now-playing track id.
    let last = trackIdFromNowPlaying()
    const t = setInterval(() => {
      const now = trackIdFromNowPlaying()
      if (now !== last) {
        last = now
        cb()
      }
    }, 1000)
    return () => clearInterval(t)
  },
  onAdChange: () => () => {
    // No reliable ad signal beyond adActive() polling; the orchestrator polls.
  },
  navigate: () => {
    // canNavigate: false — the orchestrator shows the toast flow instead.
  },
})
