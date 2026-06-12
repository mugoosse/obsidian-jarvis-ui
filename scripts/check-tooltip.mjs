// Hover-sweep until the node tooltip appears, then screenshot it.
import { chromium } from 'playwright-core'

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } })
await page.goto('http://localhost:5173/?graphShape=natural', { waitUntil: 'networkidle' })
await page.waitForSelector('canvas', { timeout: 60000 })
await page.waitForTimeout(15000)

const hasTooltip = async () =>
  page.evaluate(() => {
    const divs = [...document.querySelectorAll('div')]
    const tip = divs.find((d) => d.style.position === 'fixed' && d.style.border.includes('212'))
    return tip ? tip.innerText : null
  })

let found = null
outer: for (let y = 200; y < 900; y += 40) {
  for (let x = 400; x < 1400; x += 40) {
    await page.mouse.move(x, y)
    await page.waitForTimeout(60)
    found = await hasTooltip()
    if (found) break outer
  }
}

console.log('TOOLTIP TEXT:\n' + (found ?? 'NOT FOUND'))
if (found) await page.screenshot({ path: '/tmp/tooltip-check.png' })
await browser.close()
process.exit(found ? 0 : 1)
