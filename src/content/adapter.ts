// MediaAdapter contract (spec §12). Isolated-world DOM-only — MAIN-world
// injection is banned in v1 (§12.1). Adapters never cache the element across
// navigations; players re-mount.

import type { Service } from "../lib/types.js"

export type Unsubscribe = () => void

export type MediaAdapter = Readonly<{
  service: Service
  adapterVersion: string
  /** Retry-resolving; null while the player is mounting. */
  element: () => HTMLMediaElement | null
  mediaId: () => string | null
  canNavigate: boolean
  canDetectAd: boolean
  adActive: () => boolean
  onNavigation: (cb: () => void) => Unsubscribe
  onAdChange: (cb: (ad: boolean) => void) => Unsubscribe
  /** YouTube: real navigation. Spotify: caller falls back to the toast flow. */
  navigate: (mediaId: string) => void
}>
