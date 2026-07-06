// Media-clock sampler (spec §9): rVFC for video, edge-detected polling for
// audio and hidden tabs. timeupdate is a scheduling tick, never a sample
// source. The 15 ms target lives or dies here.

import { EDGE_WINDOW, POLL_HZ, RVFC_STALL_MS } from "../lib/constants.js"
import { fitEdges, mediaTimeAt, type EdgeFit, type EdgePoint } from "../lib/fit.js"

type VideoWithRvfc = HTMLVideoElement & {
  requestVideoFrameCallback?: (cb: (now: number, meta: { mediaTime: number; expectedDisplayTime: number }) => void) => number
  cancelVideoFrameCallback?: (handle: number) => void
}

export type SamplerSource = "rvfc" | "edge-poll" | "coarse"

export class MediaSampler {
  private edges: EdgePoint[] = []
  private fit: EdgeFit | null = null
  private lastRead: number | null = null
  private lastPollPerf: number | null = null
  private rvfcHandle: number | null = null
  private lastRvfcAt = 0
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private source: SamplerSource = "coarse"
  private el: HTMLMediaElement | null = null

  attach(el: HTMLMediaElement): void {
    if (this.el === el) return
    this.detach()
    this.el = el
    this.reset()
    const video = el as VideoWithRvfc
    if (typeof video.requestVideoFrameCallback === "function") {
      this.startRvfc(video)
    }
    this.startPolling()
  }

  detach(): void {
    if (this.pollTimer !== null) clearInterval(this.pollTimer)
    this.pollTimer = null
    const video = this.el as VideoWithRvfc | null
    if (this.rvfcHandle !== null && video?.cancelVideoFrameCallback !== undefined) {
      video.cancelVideoFrameCallback(this.rvfcHandle)
    }
    this.rvfcHandle = null
    this.el = null
  }

  /** Clear the window after seeks/navigation — old edges describe a dead timeline. */
  reset(): void {
    this.edges = []
    this.fit = null
    this.lastRead = null
    this.lastPollPerf = null
  }

  /** Fitted media position at a content-clock instant; null until the fit forms. */
  mediaTimeAt(perfMs: number): number | null {
    return this.fit === null ? null : mediaTimeAt(this.fit, perfMs)
  }

  /** Measured effective rate (feeds the watchdog §10.4 and probe §9.5). */
  slope(): number | null {
    return this.fit?.slope ?? null
  }

  jitterP95Ms(): number {
    return this.fit?.jitterP95Ms ?? Infinity
  }

  currentSource(): SamplerSource {
    if (this.fit === null) return "coarse"
    return this.source
  }

  ready(): boolean {
    return this.fit !== null
  }

  private pushEdge(point: EdgePoint): void {
    this.edges.push(point)
    if (this.edges.length > EDGE_WINDOW) this.edges = this.edges.slice(-EDGE_WINDOW)
    this.fit = fitEdges(this.edges)
  }

  private startRvfc(video: VideoWithRvfc): void {
    const loop = (_now: number, meta: { mediaTime: number; expectedDisplayTime: number }): void => {
      this.lastRvfcAt = performance.now()
      if (this.el !== video) return
      // expectedDisplayTime maps the presented frame to the wall clock with
      // sub-ms jitter — use it as the pairing instant, not the callback time.
      if (!video.paused) {
        this.source = "rvfc"
        this.pushEdge({ perfMs: meta.expectedDisplayTime, mediaSec: meta.mediaTime })
      }
      this.rvfcHandle = video.requestVideoFrameCallback?.(loop) ?? null // re-register per frame
    }
    this.rvfcHandle = video.requestVideoFrameCallback?.(loop) ?? null
  }

  private startPolling(): void {
    // rVFC is compositor-driven and stalls in hidden tabs: the poll loop is
    // both the audio sampler and the hidden-tab fallback. When rVFC is live
    // it supersedes poll edges (higher precision), so the poll loop backs off.
    this.pollTimer = setInterval(() => {
      const el = this.el
      if (el === null || el.paused) {
        this.lastRead = null
        this.lastPollPerf = null
        return
      }
      const rvfcLive = this.rvfcHandle !== null && performance.now() - this.lastRvfcAt < RVFC_STALL_MS
      if (rvfcLive) return

      const tickPerf = performance.now()
      const read = el.currentTime
      if (this.lastRead !== null && this.lastPollPerf !== null && read !== this.lastRead) {
        // The true pipeline update landed between the previous tick and this
        // one; timestamp the edge at the midpoint. Stamping at detection is
        // late by up to a poll period — a phase-locked bias the fit can't
        // average away (found by the sim; see tests/sim).
        this.source = "edge-poll"
        this.pushEdge({ perfMs: (tickPerf + this.lastPollPerf) / 2, mediaSec: read })
      }
      this.lastRead = read
      this.lastPollPerf = tickPerf
    }, 1000 / POLL_HZ)
  }
}
