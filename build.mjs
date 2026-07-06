// esbuild bundling: four contexts → dist/, plus static assets.
import { build } from "esbuild"
import { cpSync, mkdirSync } from "node:fs"

const outdir = "dist"
mkdirSync(outdir, { recursive: true })

await build({
  entryPoints: {
    sw: "src/sw.ts",
    offscreen: "src/offscreen/offscreen.ts",
    content: "src/content/content.ts",
    popup: "src/popup/popup.ts",
  },
  outdir,
  bundle: true,
  format: "esm",
  target: "chrome116",
  sourcemap: false,
  logLevel: "info",
})

cpSync("manifest.json", `${outdir}/manifest.json`)
cpSync("src/offscreen/offscreen.html", `${outdir}/offscreen.html`)
cpSync("src/popup/popup.html", `${outdir}/popup.html`)
