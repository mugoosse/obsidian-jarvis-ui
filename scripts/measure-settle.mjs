// Settle-phase stutter measurement: starts the __stutter meter as soon as the
// canvas exists (sim still running) and captures the full settling window.
import { chromium } from 'playwright-core'

const URL = process.argv[2] || 'http://localhost:5173/?graphShape=natural'
const CAPTURE_MS = Number(process.argv[3] || 25000)

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } })
const errors = []
page.on('pageerror', (err) => errors.push(err.message))

await page.goto(URL, { waitUntil: 'domcontentloaded' })
await page.waitForSelector('canvas', { timeout: 60000 })
await page.waitForFunction(() => typeof window.__stutter !== 'undefined')

const report = await page.evaluate(async (ms) => {
  window.__stutter.start()
  await new Promise((r) => setTimeout(r, ms))
  return window.__stutter.stop()
}, CAPTURE_MS)

// How long until SIM STABLE appeared (settling time proxy from UI)
const simStable = await page.evaluate(() => document.body.innerText.includes('SIM STABLE'))

console.log(JSON.stringify({ report, simStable, errors: errors.slice(0, 5) }))
await browser.close()
