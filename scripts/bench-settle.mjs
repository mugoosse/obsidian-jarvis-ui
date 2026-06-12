// Settle benchmark: time from page-load → SIM STABLE, with __stutter capture
// across the whole settling window, plus progress-indicator observations.
import { chromium } from 'playwright-core'

const URL = process.argv[2] || 'http://localhost:5173/?graphShape=natural'
const OUT = process.argv[3] || '/tmp/bench-settle'

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } })
const errors = []
page.on('pageerror', (e) => errors.push(e.message))
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })

const t0 = Date.now()
await page.goto(URL, { waitUntil: 'domcontentloaded' })
await page.waitForSelector('canvas', { timeout: 120000 })
const tCanvas = Date.now() - t0
await page.waitForFunction(() => typeof window.__stutter !== 'undefined')
await page.evaluate(() => window.__stutter.start())

let tStable = null
let sawProgress = false
let progressSamples = []
for (let i = 0; i < 480; i++) {
  const txt = await page.evaluate(() => document.body.innerText).catch(() => '')
  const m = txt.match(/COMPUTING LAYOUT (\d+)%/)
  if (m) { sawProgress = true; progressSamples.push(`${((Date.now() - t0) / 1000).toFixed(1)}s:${m[1]}%`) }
  if (txt.includes('SIM STABLE')) { tStable = Date.now() - t0; break }
  await page.waitForTimeout(250)
}
const stutter = await page.evaluate(() => window.__stutter.stop())
// let the lerp glide finish, then capture the final shape
await page.waitForTimeout(6000)
await page.screenshot({ path: `${OUT}-settled.png` })

const ui = await page.evaluate(() => document.body.innerText.slice(0, 400))
const nodes = ui.match(/NODES: (\d+)/)?.[1]
const visible = ui.match(/VISIBLE: (\d+)/)?.[1]

console.log(JSON.stringify({
  tCanvasMs: tCanvas,
  tSimStableMs: tStable,
  sawProgress,
  progressSamples: progressSamples.filter((_, i) => i % 4 === 0).slice(0, 12),
  stutter: { frames: stutter.frames, p50: stutter.p50Ms, p95: stutter.p95Ms, p99: stutter.p99Ms, max: stutter.maxMs, severeFrames: stutter.severeFrames, longTaskMax: stutter.longTasks.maxMs, durationMs: stutter.durationMs },
  nodes, visible,
  errors: errors.slice(0, 8),
}, null, 2))
await browser.close()
