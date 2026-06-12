// Headless replica of the two-phase precalc + polish, scored via check-natural-shape.
import { writeFileSync } from 'fs'
const { forceSimulation, forceLink, forceManyBody, forceCenter, forceCollide } = await import('d3-force-3d')

let data = null
for (let i = 0; i < 20; i++) {
  const raw = (await (await fetch('http://localhost:3001/api/graph')).text()).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, ' ')
  data = JSON.parse(raw)
  if (Array.isArray(data.nodes) && Array.isArray(data.links)) break
  await new Promise(r => setTimeout(r, 3000))
}
const nodes = data.nodes, links = data.links.filter(l => l.source && l.target)
const degree = new Map(nodes.map(n => [n.id, 0]))
for (const l of links) { degree.set(l.source, degree.get(l.source) + 1); degree.set(l.target, degree.get(l.target) + 1) }
const parent = new Map(nodes.map(n => [n.id, n.id]))
function find(x) { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x) } return x }
for (const l of links) parent.set(find(l.source), find(l.target))
const comps = new Map()
for (const n of nodes) { const r = find(n.id); comps.set(r, (comps.get(r) ?? 0) + 1) }
let giantRoot = null, giantSize = 0
for (const [r, s] of comps) if (s > giantSize) { giantSize = s; giantRoot = r }

const sorted = [...nodes].sort((a, b) => degree.get(b.id) - degree.get(a.id))
const tier = new Map(); sorted.forEach((n, i) => tier.set(n.id, i < 8 ? -350 : i < 50 ? -200 : -120))

const coreIds = nodes.filter(n => degree.get(n.id) >= 2 && find(n.id) === giantRoot).map(n => n.id)
const coreSet = new Set(coreIds)
const rand = () => (Math.random() - 0.5) * 400
const coreNodes = coreIds.map(id => ({ id, x: rand(), y: rand(), z: rand(), vx: 0, vy: 0, vz: 0 }))
const coreLinks = links.filter(l => coreSet.has(l.source) && coreSet.has(l.target)).map(l => ({ ...l }))

const t0 = performance.now()
const sim = forceSimulation(coreNodes, 3)
  .force('link', forceLink(coreLinks).id(d => d.id).distance(60).strength(0.5))
  .force('charge', forceManyBody().strength(d => tier.get(d.id)))
  .force('center', forceCenter(0, 0, 0).strength(0.05))
  .alphaDecay(0.055).velocityDecay(0.45).stop()
let ticks = 0, stable = 0
while (ticks < 200 && sim.alpha() >= 0.001) {
  sim.tick(); ticks++
  let t = 0; for (const n of coreNodes) t += Math.hypot(n.vx ?? 0, n.vy ?? 0, n.vz ?? 0)
  if (t / coreNodes.length < 0.5) { if (++stable >= 3) break } else stable = 0
}
const p1 = performance.now() - t0
sim.force('collide', forceCollide(12))
for (let i = 0; i < 12; i++) sim.tick()
const p2 = performance.now() - t0 - p1

// attach
const adj = new Map(nodes.map(n => [n.id, []]))
for (const l of links) { adj.get(l.source).push(l.target); adj.get(l.target).push(l.source) }
const pos = new Map(coreNodes.map(n => [n.id, { id: n.id, x: n.x, y: n.y, z: n.z }]))
let frontier = nodes.filter(n => !pos.has(n.id) && adj.get(n.id).some(m => pos.has(m))).map(n => n.id)
while (frontier.length) {
  for (const id of frontier) {
    const a = pos.get(adj.get(id).find(m => pos.has(m)))
    const r = 45 + Math.random() * 35, th = Math.random() * 2 * Math.PI, ph = Math.acos(2 * Math.random() - 1)
    pos.set(id, { id, x: a.x + r * Math.sin(ph) * Math.cos(th), y: a.y + r * Math.sin(ph) * Math.sin(th), z: a.z + r * Math.cos(ph) })
  }
  frontier = nodes.filter(n => !pos.has(n.id) && adj.get(n.id).some(m => pos.has(m))).map(n => n.id)
}
for (const n of nodes) if (!pos.has(n.id)) {
  const g = () => (Math.random() + Math.random() + Math.random() - 1.5) * 110
  pos.set(n.id, { id: n.id, x: g(), y: g(), z: g() })
}
// polish
const all = nodes.map(n => ({ ...pos.get(n.id), vx: 0, vy: 0, vz: 0 }))
const t1 = performance.now()
const polish = forceSimulation(all, 3).force('collide', forceCollide(12)).velocityDecay(0.6).alpha(0.5).stop()
for (let i = 0; i < 6; i++) polish.tick()
const p3 = performance.now() - t1

writeFileSync('/tmp/score-newalgo.json', JSON.stringify({ nodes: all.map(n => ({ id: n.id, x: n.x, y: n.y, z: n.z })), links, alpha: 0.0005 }))
console.log(JSON.stringify({ coreN: coreNodes.length, phase1Ticks: ticks, phase1Ms: Math.round(p1), phase2Ms: Math.round(p2), polishMs: Math.round(p3) }))
