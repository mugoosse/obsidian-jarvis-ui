// Right-drag realtime gate — replicates tests/right-drag.spec.ts method:
// byte-compare large center clips before / during / after the drag.
import { chromium } from 'playwright-core'

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } })
await page.goto('http://localhost:5173/?graphShape=natural', { waitUntil: 'domcontentloaded' })
await page.waitForFunction(() => document.body.innerText.includes('SIM STABLE'), null, { timeout: 180000 })
await page.waitForTimeout(4000)

const canvas = page.locator('canvas[data-engine^="three.js"]')
const box = await canvas.boundingBox()
const clip = { x: box.x + box.width * 0.2, y: box.y + box.height * 0.2, width: box.width * 0.6, height: box.height * 0.6 }
const dragX = Math.round(box.x + box.width * 0.45)
const dragY = Math.round(box.y + box.height * 0.5)

const before = await page.screenshot({ clip })
await page.mouse.move(dragX, dragY)
await page.mouse.down({ button: 'right' })
await page.mouse.move(dragX + 130, dragY, { steps: 8 })
const during = await page.screenshot({ clip })  // mid-drag, button still down — realtime check
await page.mouse.move(dragX + 260, dragY, { steps: 8 })
await page.mouse.up({ button: 'right' })
await page.waitForTimeout(400)
const after = await page.screenshot({ clip })
await page.waitForTimeout(2000)
const settled = await page.screenshot({ clip })

const eq = (a, b) => a.length === b.length && a.compare(b) === 0
console.log(JSON.stringify({
  movedDuringDrag: !eq(before, during),  // realtime: scene changed WHILE dragging
  movedAfterDrag: !eq(before, after),
  stayedAfterSettle: !eq(before, settled),
}))
await browser.close()
