// Real-time gates probe: (1) right-drag a node and verify positions stream
// live; (2) add + remove a vault note and verify the graph updates without a
// full relayout.
import { chromium } from 'playwright-core'
import { writeFileSync, unlinkSync } from 'fs'

const VAULT_TEST_NOTE = process.argv[2] // path for temp note, optional
const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } })
const errors = []
page.on('pageerror', (e) => errors.push(e.message))

await page.goto('http://localhost:5173/?graphShape=natural', { waitUntil: 'domcontentloaded' })
await page.waitForSelector('canvas', { timeout: 120000 })
// wait for settle
await page.waitForFunction(() => document.body.innerText.includes('SIM STABLE'), null, { timeout: 180000 })
await page.waitForTimeout(5000)

// ── Gate A: right-drag a node — node under cursor must follow in real time ────
// find a node: hover-sweep until tooltip appears (means raycast hit)
let hit = null
outer: for (let y = 300; y < 800; y += 35) {
  for (let x = 500; x < 1300; x += 35) {
    await page.mouse.move(x, y)
    await page.waitForTimeout(50)
    const tip = await page.evaluate(() => {
      const divs = [...document.querySelectorAll('div')]
      return divs.some((d) => d.style.position === 'fixed' && d.style.border.includes('212'))
    })
    if (tip) { hit = { x, y } ; break outer }
  }
}
let dragResult = 'NO NODE FOUND'
if (hit) {
  await page.screenshot({ path: '/tmp/drag-before.png', clip: { x: hit.x - 150, y: hit.y - 150, width: 300, height: 300 } })
  await page.mouse.move(hit.x, hit.y)
  await page.mouse.down({ button: 'right' })
  // capture mid-drag frames to verify live updates
  await page.mouse.move(hit.x + 60, hit.y + 30, { steps: 8 })
  await page.screenshot({ path: '/tmp/drag-mid.png', clip: { x: hit.x - 150, y: hit.y - 150, width: 300, height: 300 } })
  await page.mouse.move(hit.x + 120, hit.y + 60, { steps: 8 })
  await page.mouse.up({ button: 'right' })
  await page.waitForTimeout(1500)
  await page.screenshot({ path: '/tmp/drag-after.png', clip: { x: hit.x - 150, y: hit.y - 150, width: 300, height: 300 } })
  dragResult = `dragged from ${hit.x},${hit.y}`
}

// ── Gate B: vault note add/remove — graph must update live, no full relayout ──
let addRemove = null
if (VAULT_TEST_NOTE) {
  const countNodes = () => page.evaluate(() => {
    const m = document.body.innerText.match(/NODES: (\d+)/)
    return m ? parseInt(m[1], 10) : null
  })
  const before = await countNodes()
  writeFileSync(VAULT_TEST_NOTE, '# Jarvis realtime gate test\n\nTemporary note — links to nothing.\n')
  // wait for watcher (1.5s debounce) + rebuild + client poll (4s) + refetch
  let after = before
  const t0 = Date.now()
  let progressSeen = false
  while (Date.now() - t0 < 120000) {
    const txt = await page.evaluate(() => document.body.innerText)
    if (/COMPUTING LAYOUT/.test(txt)) progressSeen = true
    const m = txt.match(/NODES: (\d+)/)
    if (m && parseInt(m[1], 10) === before + 1) { after = before + 1; break }
    await page.waitForTimeout(1000)
  }
  const addLatencyS = ((Date.now() - t0) / 1000).toFixed(1)
  // remove it again
  unlinkSync(VAULT_TEST_NOTE)
  let removed = false
  const t1 = Date.now()
  while (Date.now() - t1 < 120000) {
    const n = await countNodes()
    if (n === before) { removed = true; break }
    await page.waitForTimeout(1000)
  }
  addRemove = {
    before, afterAdd: after, addLatencyS,
    removedBack: removed, removeLatencyS: ((Date.now() - t1) / 1000).toFixed(1),
    fullRelayoutTriggered: progressSeen, // must be false — warm path only
  }
}

console.log(JSON.stringify({ dragResult, addRemove, errors: errors.slice(0, 5) }, null, 2))
await browser.close()
