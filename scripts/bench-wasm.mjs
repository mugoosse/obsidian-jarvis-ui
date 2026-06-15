// Head-to-head: JS d3-force-3d core sim vs Rust/WASM core sim, identical inputs.
// Verifies shape parity (writes both position sets for check-natural-shape) and
// measures wall-time speedup. Run with the dev server up (for /api/graph).
import { readFileSync, writeFileSync } from 'fs'
const d3 = await import('d3-force-3d')
const { forceSimulation, forceLink, forceManyBody, forceCenter, forceCollide } = d3

const WASM_PATH = new URL('../wasm/force-sim/target/wasm32-unknown-unknown/release/force_sim.wasm', import.meta.url)
const RUNS = Number(process.argv[2] || 3)

// ── params (mirror force3d.worker.ts precalc) ─────────────────────────────────
const LINK_DIST = 60, LINK_STR = 0.5, THETA2 = 0.81, DMIN2 = 1
const CENTER_STR = 0.05, ALPHA_DECAY = 0.055, VEL_DECAY = 0.45
const MAX_TICKS = 200, ALPHA_MIN = 0.001, EARLY_VEL = 0.5
const COLLIDE_R = 12, COLLIDE_TICKS = 12

// ── load graph + build core set ──────────────────────────────────────────────
let data = null
for (let i = 0; i < 30; i++) {
  try {
    const raw = (await (await fetch('http://localhost:3001/api/graph')).text()).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, ' ')
    data = JSON.parse(raw)
    if (Array.isArray(data.nodes) && Array.isArray(data.links)) break
  } catch { /* server busy/rebuilding — retry */ }
  await new Promise(r => setTimeout(r, 3000))
}
if (!data || !Array.isArray(data.nodes)) { console.error('graph never ready'); process.exit(2) }
const nodes = data.nodes
const links = data.links.filter(l => l.source && l.target)

const degree = new Map(nodes.map(n => [n.id, 0]))
for (const l of links) { degree.set(l.source, degree.get(l.source) + 1); degree.set(l.target, degree.get(l.target) + 1) }
const parent = new Map(nodes.map(n => [n.id, n.id]))
function find(x) { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x) } return x }
for (const l of links) parent.set(find(l.source), find(l.target))
const comp = new Map()
for (const n of nodes) { const r = find(n.id); comp.set(r, (comp.get(r) ?? 0) + 1) }
let giant = null, gsz = 0
for (const [r, s] of comp) if (s > gsz) { gsz = s; giant = r }

const sorted = [...nodes].sort((a, b) => degree.get(b.id) - degree.get(a.id))
const tier = new Map()
sorted.forEach((n, i) => tier.set(n.id, i < 8 ? -350 : i < 50 ? -200 : -120))

const coreIds = nodes.filter(n => degree.get(n.id) >= 2 && find(n.id) === giant).map(n => n.id)
const N = coreIds.length
const idx = new Map(coreIds.map((id, i) => [id, i]))
const coreLinks = links.filter(l => idx.has(l.source) && idx.has(l.target))
const M = coreLinks.length

// seeded initial positions — identical for both engines
function lcg(seed) { let s = seed >>> 0; return () => { s = (1664525 * s + 1013904223) >>> 0; return s / 4294967296 } }
const rng = lcg(12345)
const initPos = new Float32Array(N * 3)
for (let i = 0; i < N * 3; i++) initPos[i] = (rng() - 0.5) * 400
const charge = new Float32Array(N)
coreIds.forEach((id, i) => { charge[i] = tier.get(id) })
const linkPairs = new Uint32Array(M * 2)
coreLinks.forEach((l, i) => { linkPairs[i * 2] = idx.get(l.source); linkPairs[i * 2 + 1] = idx.get(l.target) })

console.error(`core: N=${N} nodes, M=${M} links (giant ${gsz}/${nodes.length})`)

// ── JS engine (exact worker core sim) ─────────────────────────────────────────
function runJS() {
  const sn = coreIds.map((id, i) => ({ id, x: initPos[i * 3], y: initPos[i * 3 + 1], z: initPos[i * 3 + 2], vx: 0, vy: 0, vz: 0 }))
  const sl = coreLinks.map(l => ({ source: l.source, target: l.target }))
  const chargeOf = (d) => tier.get(d.id)
  const t0 = performance.now()
  const sim = forceSimulation(sn, 3)
    .force('link', forceLink(sl).id(d => d.id).distance(LINK_DIST).strength(LINK_STR))
    .force('charge', forceManyBody().strength(chargeOf))
    .force('center', forceCenter(0, 0, 0).strength(CENTER_STR))
    .alphaDecay(ALPHA_DECAY).velocityDecay(VEL_DECAY).stop()
  let ticks = 0, stable = 0
  while (ticks < MAX_TICKS && sim.alpha() >= ALPHA_MIN) {
    sim.tick(); ticks++
    let tv = 0; for (const n of sn) tv += Math.hypot(n.vx, n.vy, n.vz)
    if (tv / N < EARLY_VEL) { if (++stable >= 3) break } else stable = 0
  }
  const p1 = ticks
  sim.force('collide', forceCollide(COLLIDE_R))
  for (let i = 0; i < COLLIDE_TICKS; i++) { sim.tick(); ticks++ }
  const ms = performance.now() - t0
  const pos = new Float32Array(N * 3)
  sn.forEach((n, i) => { pos[i * 3] = n.x; pos[i * 3 + 1] = n.y; pos[i * 3 + 2] = n.z })
  return { ms, ticks, p1, pos }
}

// ── WASM engine ────────────────────────────────────────────────────────────────
const wasmBytes = readFileSync(WASM_PATH)
const { instance } = await WebAssembly.instantiate(wasmBytes, {})
const ex = instance.exports
function runWASM() {
  const posPtr = ex.alloc(N * 3 * 4)
  const chargePtr = ex.alloc(N * 4)
  const linkPtr = ex.alloc(M * 2 * 4)
  new Float32Array(ex.memory.buffer, posPtr, N * 3).set(initPos)
  new Float32Array(ex.memory.buffer, chargePtr, N).set(charge)
  new Uint32Array(ex.memory.buffer, linkPtr, M * 2).set(linkPairs)
  const t0 = performance.now()
  const packed = ex.run_core(N, posPtr, chargePtr, M, linkPtr, LINK_DIST, LINK_STR, DMIN2, THETA2, CENTER_STR, ALPHA_DECAY, VEL_DECAY, MAX_TICKS, ALPHA_MIN, EARLY_VEL, COLLIDE_R, COLLIDE_TICKS)
  const ms = performance.now() - t0
  const p1 = packed >>> 16, ticks = packed & 0xFFFF
  // re-view: memory may have grown during the call
  const pos = new Float32Array(ex.memory.buffer, posPtr, N * 3).slice()
  ex.dealloc(posPtr, N * 3 * 4); ex.dealloc(chargePtr, N * 4); ex.dealloc(linkPtr, M * 2 * 4)
  return { ms, ticks, p1, pos }
}

// ── run + report ──────────────────────────────────────────────────────────────
const jsRuns = [], wasmRuns = []
let jsLast = null, wasmLast = null
// warm-up
runJS(); runWASM()
for (let r = 0; r < RUNS; r++) { jsLast = runJS(); jsRuns.push(jsLast.ms) }
for (let r = 0; r < RUNS; r++) { wasmLast = runWASM(); wasmRuns.push(wasmLast.ms) }
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)] }
const jsMed = med(jsRuns), wasmMed = med(wasmRuns)

// emit position files (attach is identical for both, skip — score the core only)
const scoreFile = (pos, name) => {
  const out = coreIds.map((id, i) => ({ id, x: pos[i * 3], y: pos[i * 3 + 1], z: pos[i * 3 + 2] }))
  writeFileSync(`/tmp/wasm-pos-${name}.json`, JSON.stringify({ nodes: out, links: coreLinks, alpha: 0.0005 }))
}
scoreFile(jsLast.pos, 'js')
scoreFile(wasmLast.pos, 'wasm')

console.log(JSON.stringify({
  N, M,
  js: { medMs: +jsMed.toFixed(1), runs: jsRuns.map(x => +x.toFixed(0)), ticks: jsLast.ticks, phase1: jsLast.p1 },
  wasm: { medMs: +wasmMed.toFixed(1), runs: wasmRuns.map(x => +x.toFixed(0)), ticks: wasmLast.ticks, phase1: wasmLast.p1 },
  speedup: +(jsMed / wasmMed).toFixed(2),
  improvementPct: +(((jsMed - wasmMed) / wasmMed) * 100).toFixed(0),
}, null, 2))
