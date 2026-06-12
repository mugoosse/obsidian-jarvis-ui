#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Natural-layout bottleneck profiler — replicates the worker's exact natural sim
// headlessly, times each force per tick, and A/B tests optimization strategies:
//   baseline : random init, full node set (current worker behavior)
//   smartinit: community-seeded initial positions (label propagation), full set
//   coresim  : simulate only deg>=2 giant-component core; attach leaves/orphans
//              analytically afterwards
//   combined : smartinit + coresim
// Each variant writes positions JSON for shape scoring via check-natural-shape.mjs.
import { writeFileSync } from 'fs'

const { forceSimulation, forceLink, forceManyBody, forceCenter, forceCollide } = await import('d3-force-3d')

const API = 'http://localhost:3001/api/graph'
const ALPHA_MIN = 0.001
const MAX_TICKS = 200

// ── Load graph ────────────────────────────────────────────────────────────────
let data = null
for (let i = 0; i < 20; i++) {
  const res = await fetch(API)
  const raw = (await res.text()).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, ' ')
  data = JSON.parse(raw)
  if (Array.isArray(data.nodes)) break
  console.error(`graph not ready (${data.status ?? 'unknown'}), retrying...`)
  await new Promise(r => setTimeout(r, 3000))
}
if (!Array.isArray(data?.nodes)) { console.error('graph never became ready'); process.exit(2) }
const nodes = data.nodes
const links = (data.links ?? []).filter(l => l.source && l.target)
console.error(`graph: ${nodes.length} nodes, ${links.length} links`)

// ── Degree + component stats ──────────────────────────────────────────────────
const degree = new Map(nodes.map(n => [n.id, 0]))
for (const l of links) {
  degree.set(l.source, (degree.get(l.source) ?? 0) + 1)
  degree.set(l.target, (degree.get(l.target) ?? 0) + 1)
}
const parent = new Map(nodes.map(n => [n.id, n.id]))
function find(x) { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x) } return x }
for (const l of links) parent.set(find(l.source), find(l.target))
const comps = new Map()
for (const n of nodes) { const r = find(n.id); comps.set(r, (comps.get(r) ?? 0) + 1) }
let giantRoot = null, giantSize = 0
for (const [r, s] of comps) if (s > giantSize) { giantSize = s; giantRoot = r }
const inGiant = new Set(nodes.filter(n => find(n.id) === giantRoot).map(n => n.id))

const deg0 = nodes.filter(n => (degree.get(n.id) ?? 0) === 0).length
const deg1 = nodes.filter(n => (degree.get(n.id) ?? 0) === 1).length
const giantLeaves = nodes.filter(n => inGiant.has(n.id) && degree.get(n.id) === 1).length
console.error(`degree: deg0=${deg0} deg1=${deg1} deg2+=${nodes.length - deg0 - deg1}`)
console.error(`components: ${comps.size} total, giant=${giantSize} (${(giantSize / nodes.length * 100).toFixed(1)}%), giant leaves=${giantLeaves}`)

// ── Tier map (mirrors worker: by degree) ──────────────────────────────────────
const sortedByDeg = [...nodes].sort((a, b) => (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0))
const tierMap = new Map()
sortedByDeg.forEach((n, i) => {
  tierMap.set(n.id, i < 8 ? 'ultranode' : i < 50 ? 'supernode' : 'regular')
})

// ── Label propagation communities (for smart init) ───────────────────────────
function labelPropagation(iters = 5) {
  const adj = new Map(nodes.map(n => [n.id, []]))
  for (const l of links) { adj.get(l.source)?.push(l.target); adj.get(l.target)?.push(l.source) }
  const label = new Map(nodes.map(n => [n.id, n.id]))
  const order = nodes.map(n => n.id)
  for (let it = 0; it < iters; it++) {
    for (const id of order) {
      const neigh = adj.get(id)
      if (!neigh || neigh.length === 0) continue
      const counts = new Map()
      for (const m of neigh) { const lb = label.get(m); counts.set(lb, (counts.get(lb) ?? 0) + 1) }
      let best = label.get(id), bestC = 0
      for (const [lb, c] of counts) if (c > bestC) { bestC = c; best = lb }
      label.set(id, best)
    }
  }
  return label
}

// ── Sim runner with per-force timing ──────────────────────────────────────────
function runSim(simNodes, simLinks, { collect = false } = {}) {
  const naturalCharge = (d) => {
    const tier = tierMap.get(d.id) ?? 'regular'
    return tier === 'ultranode' ? -350 : tier === 'supernode' ? -200 : -120
  }
  const isolatedIds = new Set(simNodes.filter(n => !inGiant.has(n.id)).map(n => n.id))
  const isolatedForce = (alpha) => {
    const k = alpha * 0.08
    for (const node of simNodes) {
      if (isolatedIds.has(node.id)) { node.vx -= node.x * k; node.vy -= node.y * k; node.vz -= node.z * k }
    }
  }

  const forceTime = { link: 0, charge: 0, center: 0, collide: 0, isolated: 0 }
  const timed = (name, f) => {
    const g = (alpha) => { const t = performance.now(); f(alpha); forceTime[name] += performance.now() - t }
    if (f.initialize) g.initialize = (...a) => f.initialize(...a)
    return g
  }

  const sim = forceSimulation(simNodes, 3)
    .force('link', timed('link', forceLink(simLinks).id(d => d.id).distance(60).strength(0.5)))
    .force('charge', timed('charge', forceManyBody().strength(naturalCharge)))
    .force('center', timed('center', forceCenter(0, 0, 0).strength(0.05)))
    .force('collide', timed('collide', forceCollide(12)))
    .force('isolated', isolatedForce)
    .alphaDecay(0.055)
    .velocityDecay(0.45)
    .stop()

  const tickMs = []
  let stable = 0
  const t0 = performance.now()
  let ticks = 0
  while (ticks < MAX_TICKS && sim.alpha() >= ALPHA_MIN) {
    const t = performance.now()
    sim.tick()
    ticks++
    tickMs.push(performance.now() - t)
    // worker's early-exit: mean velocity < 0.5 for 3 consecutive ticks
    let total = 0
    for (const n of simNodes) total += Math.sqrt((n.vx ?? 0) ** 2 + (n.vy ?? 0) ** 2 + (n.vz ?? 0) ** 2)
    if (total / simNodes.length < 0.5) { if (++stable >= 3) break } else stable = 0
  }
  const wall = performance.now() - t0
  tickMs.sort((a, b) => a - b)
  const pct = (p) => tickMs[Math.min(tickMs.length - 1, Math.floor(p * tickMs.length))] ?? 0
  return {
    ticks, wallMs: Math.round(wall),
    tickP50: +pct(0.5).toFixed(1), tickP95: +pct(0.95).toFixed(1), tickMax: +(tickMs[tickMs.length - 1] ?? 0).toFixed(1),
    forceMs: Object.fromEntries(Object.entries(forceTime).map(([k, v]) => [k, Math.round(v)])),
    positions: collect ? simNodes.map(n => ({ id: n.id, x: n.x, y: n.y, z: n.z })) : undefined,
  }
}

const rand = () => (Math.random() - 0.5) * 400
const mkNodes = (ids, init) => ids.map(id => {
  const p = init?.get(id)
  return { id, x: p?.x ?? rand(), y: p?.y ?? rand(), z: p?.z ?? rand(), vx: 0, vy: 0, vz: 0 }
})
const allIds = nodes.map(n => n.id)
const linkPairs = links.map(l => ({ source: l.source, target: l.target }))

// ── Variant: smart init — communities on a sphere, members jittered around it ──
function smartInitPositions() {
  const label = labelPropagation()
  const commMembers = new Map()
  for (const id of allIds) {
    const lb = label.get(id)
    if (!commMembers.has(lb)) commMembers.set(lb, [])
    commMembers.get(lb).push(id)
  }
  const comms = [...commMembers.entries()].sort((a, b) => b[1].length - a[1].length)
  const init = new Map()
  comms.forEach(([, members], i) => {
    // golden-spiral sphere placement; radius grows with community rank
    const phi = Math.acos(1 - 2 * ((i + 0.5) / comms.length))
    const theta = Math.PI * (1 + Math.sqrt(5)) * i
    const R = members.length > 3 ? 250 : 420
    const cx = R * Math.sin(phi) * Math.cos(theta), cy = R * Math.sin(phi) * Math.sin(theta), cz = R * Math.cos(phi)
    const jitter = 18 * Math.cbrt(members.length)
    for (const id of members) {
      init.set(id, {
        x: cx + (Math.random() - 0.5) * jitter,
        y: cy + (Math.random() - 0.5) * jitter,
        z: cz + (Math.random() - 0.5) * jitter,
      })
    }
  })
  return init
}

// ── Variant: core sim — deg>=2 in giant comp + community reps; leaves attached after ──
function coreSplit() {
  const coreIds = allIds.filter(id => inGiant.has(id) && (degree.get(id) ?? 0) >= 2)
  const coreSet = new Set(coreIds)
  const coreLinks = linkPairs.filter(l => coreSet.has(l.source) && coreSet.has(l.target))
  return { coreIds, coreSet, coreLinks }
}
function attachPeripherals(corePos) {
  const out = new Map(corePos)
  const adj = new Map()
  for (const l of linkPairs) {
    if (!adj.has(l.source)) adj.set(l.source, [])
    if (!adj.has(l.target)) adj.set(l.target, [])
    adj.get(l.source).push(l.target)
    adj.get(l.target).push(l.source)
  }
  // BFS attach: any unplaced node adjacent to a placed one gets parent + offset
  let frontier = allIds.filter(id => !out.has(id) && (adj.get(id) ?? []).some(m => out.has(m)))
  while (frontier.length > 0) {
    for (const id of frontier) {
      const anchor = (adj.get(id) ?? []).find(m => out.has(m))
      const p = out.get(anchor)
      const r = 45 + Math.random() * 35
      const th = Math.random() * 2 * Math.PI, ph = Math.acos(2 * Math.random() - 1)
      out.set(id, { x: p.x + r * Math.sin(ph) * Math.cos(th), y: p.y + r * Math.sin(ph) * Math.sin(th), z: p.z + r * Math.cos(ph) })
    }
    frontier = allIds.filter(id => !out.has(id) && (adj.get(id) ?? []).some(m => out.has(m)))
  }
  // isolated comps + orphans: gaussian ball near center (isolatedForce equilibrium)
  for (const id of allIds) {
    if (!out.has(id)) {
      const g = () => (Math.random() + Math.random() + Math.random() - 1.5) * 110
      out.set(id, { x: g(), y: g(), z: g() })
    }
  }
  return out
}

// ── Run experiments ───────────────────────────────────────────────────────────
const results = {}

console.error('\n[1/4] baseline (random init, all nodes)...')
results.baseline = runSim(mkNodes(allIds), linkPairs.map(l => ({ ...l })), { collect: true })
writeFileSync('/tmp/profile-pos-baseline.json', JSON.stringify(results.baseline.positions))
delete results.baseline.positions

console.error('[2/4] smartinit (community-seeded, all nodes)...')
const t0 = performance.now()
const init = smartInitPositions()
const initMs = Math.round(performance.now() - t0)
results.smartinit = runSim(mkNodes(allIds, init), linkPairs.map(l => ({ ...l })), { collect: true })
results.smartinit.initMs = initMs
writeFileSync('/tmp/profile-pos-smartinit.json', JSON.stringify(results.smartinit.positions))
delete results.smartinit.positions

console.error('[3/4] coresim (deg>=2 giant core, leaves attached)...')
const { coreIds, coreLinks } = coreSplit()
console.error(`  core: ${coreIds.length} nodes, ${coreLinks.length} links`)
const coreRun = runSim(mkNodes(coreIds), coreLinks.map(l => ({ ...l })), { collect: true })
let t1 = performance.now()
const corePos = new Map(coreRun.positions.map(p => [p.id, p]))
const fullPos = attachPeripherals(corePos)
const attachMs = Math.round(performance.now() - t1)
results.coresim = { ...coreRun, attachMs, coreN: coreIds.length }
delete results.coresim.positions
writeFileSync('/tmp/profile-pos-coresim.json', JSON.stringify(allIds.map(id => ({ id, ...fullPos.get(id) }))))

console.error('[4/4] combined (smartinit + coresim)...')
const coreInit = new Map([...init.entries()].filter(([id]) => coreIds.includes(id)))
const combRun = runSim(mkNodes(coreIds, coreInit), coreLinks.map(l => ({ ...l })), { collect: true })
t1 = performance.now()
const combFull = attachPeripherals(new Map(combRun.positions.map(p => [p.id, p])))
const combAttachMs = Math.round(performance.now() - t1)
results.combined = { ...combRun, initMs, attachMs: combAttachMs, coreN: coreIds.length }
delete results.combined.positions
writeFileSync('/tmp/profile-pos-combined.json', JSON.stringify(allIds.map(id => ({ id, ...combFull.get(id) }))))

results.meta = { nodes: nodes.length, links: links.length, deg0, deg1, giant: giantSize, components: comps.size }
console.log(JSON.stringify(results, null, 2))
