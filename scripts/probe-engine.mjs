import { chromium } from 'playwright-core'
const b = await chromium.launch({ headless: true })
const p = await b.newPage({ viewport: { width: 1600, height: 1000 } })
const logs = []
p.on('console', (m) => { const t = m.text(); if (/precalc-engine|error/i.test(t)) logs.push(t) })
p.on('pageerror', (e) => logs.push('PAGEERROR: ' + e.message))
const t0 = Date.now()
await p.goto('http://localhost:5173/?graphShape=natural', { waitUntil: 'domcontentloaded' })
await p.waitForSelector('canvas', { timeout: 120000 })
const tc = Date.now() - t0
let tStable = null
for (let i = 0; i < 240; i++) {
  const txt = await p.evaluate(() => document.body.innerText).catch(() => '')
  if (txt.includes('SIM STABLE')) { tStable = Date.now() - t0; break }
  await p.waitForTimeout(250)
}
await p.waitForTimeout(4000)
await p.screenshot({ path: '/tmp/wasm-app-settled.png' })
const ui = await p.evaluate(() => document.body.innerText.slice(0, 200))
console.log(JSON.stringify({ tCanvasMs: tc, tSimStableMs: tStable, settleMs: tStable ? tStable - tc : null, nodes: ui.match(/NODES: (\d+)/)?.[1], visible: ui.match(/VISIBLE: (\d+)/)?.[1], logs }))
await b.close()
