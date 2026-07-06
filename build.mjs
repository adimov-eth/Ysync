// esbuild bundling: four contexts → dist/, plus static assets.
import { build } from "esbuild"
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"

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

// E2E build: same code, manifest additionally matches the local fixture
// server. Never ship dist-e2e.
const e2eDir = "dist-e2e"
mkdirSync(e2eDir, { recursive: true })
for (const f of ["sw.js", "offscreen.js", "content.js", "popup.js"]) {
  cpSync(`${outdir}/${f}`, `${e2eDir}/${f}`)
}
cpSync("src/offscreen/offscreen.html", `${e2eDir}/offscreen.html`)
cpSync("src/popup/popup.html", `${e2eDir}/popup.html`)
const manifest = JSON.parse(readFileSync("manifest.json", "utf8"))
manifest.name = "Chorus (e2e)"
manifest.content_scripts.push({
  matches: ["http://localhost/*", "http://127.0.0.1/*"],
  js: ["content.js"],
  run_at: "document_idle",
})
writeFileSync(`${e2eDir}/manifest.json`, JSON.stringify(manifest, null, 2))
