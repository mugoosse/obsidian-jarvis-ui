// Standalone runtime verification driver (not a test) — loads the app,
// waits for the natural-pattern graph to settle, screenshots it, and
// measures main-thread stutter via the in-page __stutter meter.
import { chromium } from 'playwright-core'

const OUT = process.argv[2] || '/tmp/jarvis-verify'
const URL = process.argv[3] || 'http://localhost:5173/?graphShape=natural'

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } })

const consoleErrors = []
page.on('console', (msg) => {
  if (msg.type() === 'error') consoleErrors.push(msg.text())
})
page.on('pageerror', (err) => consoleErrors.push('PAGEERROR: ' + err.message))

await page.goto(URL, { waitUntil: 'networkidle' })
await page.waitForSelector('canvas', { timeout: 60000 })

// Wait for layout to settle: poll until the build/loading UI is gone, then dwell
const t0 = Date.now()
while (Date.now() - t0 < 90000) {
  let busy = true
  try {
    busy = await page.evaluate(() => {
      const txt = document.body.innerText.toLowerCase()
      return /building|loading|linking/.test(txt)
    })
  } catch {
    // page navigated/reloaded mid-poll — wait for it to come back
    await page.waitForLoadState('networkidle').catch(() => {})
  }
  if (!busy) break
  await page.waitForTimeout(1000)
}
await page.screenshot({ path: `${OUT}-early.png` })
await page.waitForTimeout(20000) // let force layout settle
await page.screenshot({ path: `${OUT}-settled.png` })

// Stutter capture: 10s idle observation
const idleReport = await page.evaluate(async () => {
  window.__stutter.start()
  await new Promise((r) => setTimeout(r, 10000))
  return window.__stutter.stop()
})

// Stutter capture during camera interaction (drag rotate)
const box = await page.locator('canvas').first().boundingBox()
const cx = box.x + box.width / 2
const cy = box.y + box.height / 2
await page.evaluate(() => window.__stutter.start())
for (let i = 0; i < 3; i++) {
  await page.mouse.move(cx, cy)
  await page.mouse.down()
  await page.mouse.move(cx + 250, cy + 120, { steps: 25 })
  await page.mouse.move(cx - 250, cy - 120, { steps: 25 })
  await page.mouse.up()
}
const dragReport = await page.evaluate(() => window.__stutter.stop())
await page.screenshot({ path: `${OUT}-after-drag.png` })

const uiText = await page.evaluate(() => document.body.innerText.slice(0, 2000))

console.log(JSON.stringify({ idleReport, dragReport, consoleErrors: consoleErrors.slice(0, 20), uiText }, null, 2))
await browser.close()
