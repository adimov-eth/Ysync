// E2E: two Chrome profiles pair via programmatic blob hand-off and reach
// `connected` over a real WebRTC DataChannel (spec §16.2). Runs headless
// with --headless=new (extensions supported). LAN-only mode + raw host IPs
// (mDNS obfuscation disabled) so no STUN is needed — both profiles are on
// the same machine.
//
// Run: npm run e2e   (builds first; see package.json)

import { expect, test, chromium, type BrowserContext, type Page } from "@playwright/test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const DIST = join(import.meta.dirname, "../../dist")

const launch = async (): Promise<BrowserContext> =>
  chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), "chorus-e2e-")), {
    headless: true,
    executablePath: process.env["CHROMIUM_PATH"] ?? "/opt/pw-browsers/chromium",
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
  const id = await extensionId(ctx)
  const page = await ctx.newPage()
  await page.goto(`chrome-extension://${id}/popup.html`)
  return page
}

test("two profiles pair via blob hand-off and connect", async () => {
  test.setTimeout(120_000)
  const hostCtx = await launch()
  const guestCtx = await launch()
  try {
    const host = await openPopup(hostCtx)
    const guest = await openPopup(guestCtx)

    // Host: create room (LAN-only: no STUN reachable in CI).
    await host.fill("#device-name", "HostMac")
    await host.check("#lan-only")
    await host.click("#btn-create")
    await expect(host.locator("#screen-hosting")).toBeVisible()

    // Host: add peer → offer blob.
    await host.click("#btn-add-peer")
    const offerArea = host.locator("#offer-blob")
    await expect(offerArea).toBeVisible({ timeout: 30_000 })
    await expect(offerArea).not.toHaveValue("", { timeout: 30_000 })
    const offer = await offerArea.inputValue()
    expect(offer.length).toBeGreaterThan(100)

    // Guest: join → answer blob.
    await guest.fill("#device-name", "GuestMac")
    await guest.check("#lan-only")
    await guest.click("#btn-join")
    await guest.fill("#join-blob", offer)
    await guest.click("#btn-join-go")
    const answerArea = guest.locator("#joined-answer")
    await expect(answerArea).toBeVisible({ timeout: 30_000 })
    await expect(answerArea).not.toHaveValue("", { timeout: 30_000 })
    const answer = await answerArea.inputValue()

    // Host: accept answer → DataChannels open → hello → peer row appears.
    await host.fill("#paste-answer", answer)
    await host.click("#btn-accept-answer")
    await expect(host.locator("#peer-list .peer")).toHaveCount(1, { timeout: 30_000 })
    await expect(host.locator("#peer-list .peer")).toContainText("GuestMac", { timeout: 30_000 })

    // Guest: joined screen shows the host and a warming/locked clock.
    await expect(guest.locator("#screen-joined")).toBeVisible()
    await expect(guest.locator("#joined-host")).toContainText("HostMac")
    await expect(guest.locator("#self-drift")).toContainText("clock", { timeout: 30_000 })
  } finally {
    await hostCtx.close()
    await guestCtx.close()
  }
})
