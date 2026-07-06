// E2E media sync over the fixture adapter: two profiles pair, host plays,
// follower converges. This verifies the full pipeline — election, media
// port, both clock hops, beacons, activation, probe, servo — with real
// media elements. Precision claims live in tests/sim; this asserts the
// plumbing converges to well under human-noticeable error.

import { expect, test, chromium, type BrowserContext, type Page } from "@playwright/test"
import { mkdtempSync, readFileSync } from "node:fs"
import { createServer, type Server } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"

const DIST = join(import.meta.dirname, "../../dist-e2e")
const FIXTURE = join(import.meta.dirname, "../fixtures/media.html")
const chromiumPath = process.env["CHROMIUM_PATH"]

const serveFixture = (): Promise<{ server: Server; url: string }> =>
  new Promise((resolve) => {
    const html = readFileSync(FIXTURE, "utf8")
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html" })
      res.end(html)
    })
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address()
      const port = typeof addr === "object" && addr !== null ? addr.port : 0
      resolve({ server, url: `http://127.0.0.1:${port}/fixture` })
    })
  })

const launch = async (): Promise<BrowserContext> =>
  chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), "chorus-sync-")), {
    headless: process.env["CHORUS_E2E_HEADLESS"] === "1",
    ...(chromiumPath === undefined ? {} : { executablePath: chromiumPath }),
    args: [
      `--disable-extensions-except=${DIST}`,
      `--load-extension=${DIST}`,
      "--disable-features=WebRtcHideLocalIpsWithMdns",
      "--autoplay-policy=no-user-gesture-required",
    ],
  })

const extensionId = async (ctx: BrowserContext): Promise<string> => {
  let [sw] = ctx.serviceWorkers()
  sw ??= await ctx.waitForEvent("serviceworker")
  return new URL(sw.url()).host
}

const openPopup = async (ctx: BrowserContext): Promise<Page> => {
  const page = await ctx.newPage()
  await page.goto(`chrome-extension://${await extensionId(ctx)}/popup.html`)
  return page
}

declare global {
  interface Window { fixture: { play: () => Promise<void>; pause: () => void; seek: (t: number) => void; time: () => number; setAd: (on: boolean) => void } }
}

test("follower converges on host playback and tracks a seek", async () => {
  test.setTimeout(240_000)
  const { server, url } = await serveFixture()
  const hostCtx = await launch()
  const guestCtx = await launch()
  try {
    // Media tabs first so content scripts register with their SWs.
    const hostMedia = await hostCtx.newPage()
    await hostMedia.goto(url)
    const guestMedia = await guestCtx.newPage()
    await guestMedia.goto(url)

    // Pair (LAN-only; loopback host candidates).
    const host = await openPopup(hostCtx)
    const guest = await openPopup(guestCtx)
    await host.fill("#device-name", "HostMac")
    await host.check("#lan-only")
    await host.click("#btn-create")
    await host.click("#btn-add-peer")
    const offerArea = host.locator("#offer-blob")
    await expect(offerArea).not.toHaveValue("", { timeout: 30_000 })
    const offer = await offerArea.inputValue()

    await guest.fill("#device-name", "GuestMac")
    await guest.check("#lan-only")
    await guest.click("#btn-join")
    await guest.fill("#join-blob", offer)
    await guest.click("#btn-join-go")
    const answerArea = guest.locator("#joined-answer")
    await expect(answerArea).not.toHaveValue("", { timeout: 30_000 })
    await host.fill("#paste-answer", await answerArea.inputValue())
    await host.click("#btn-accept-answer")
    await expect(host.locator("#peer-list .peer")).toHaveCount(1, { timeout: 30_000 })

    // Host starts playback mid-file; the follower must converge from zero.
    await hostMedia.evaluate(() => {
      window.fixture.seek(20)
      return window.fixture.play()
    })

    // Wait for the guest element to be playing (activation machine).
    await expect
      .poll(async () => guestMedia.evaluate(() => window.fixture.time()), { timeout: 60_000 })
      .toBeGreaterThan(1)

    // Give clock warmup + probe + servo time to settle, then measure drift.
    await hostMedia.waitForTimeout(25_000)
    const drift = async (): Promise<number> => {
      const [h, g] = await Promise.all([
        hostMedia.evaluate(() => window.fixture.time()),
        guestMedia.evaluate(() => window.fixture.time()),
      ])
      return Math.abs(h - g)
    }
    const drifts: number[] = []
    for (let i = 0; i < 5; i++) {
      drifts.push(await drift())
      await hostMedia.waitForTimeout(1000)
    }
    drifts.sort((a, b) => a - b)
    const median = drifts[2] ?? Infinity
    // Cross-page evaluate skew + fixture pipeline put a floor well above the
    // 15 ms target — the sim owns precision; this asserts real convergence.
    expect(median).toBeLessThan(0.25)

    // Host seeks: follower must re-converge (epoch bump → hard sync).
    await hostMedia.evaluate(() => window.fixture.seek(60))
    await hostMedia.waitForTimeout(8_000)
    const after: number[] = []
    for (let i = 0; i < 3; i++) {
      after.push(await drift())
      await hostMedia.waitForTimeout(1000)
    }
    after.sort((a, b) => a - b)
    expect(after[1] ?? Infinity).toBeLessThan(0.35)

    // Host pause propagates.
    await hostMedia.evaluate(() => window.fixture.pause())
    await expect
      .poll(async () => guestMedia.evaluate(() => document.querySelector<HTMLMediaElement>("#chorus-media")?.paused ?? false), { timeout: 10_000 })
      .toBe(true)
  } finally {
    await hostCtx.close()
    await guestCtx.close()
    server.close()
  }
})
