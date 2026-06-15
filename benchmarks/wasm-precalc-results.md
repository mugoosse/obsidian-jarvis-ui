# Natural precalc: Rust/WASM port — profiling + benchmark (2026-06-15)

Branch `perf/natural-precalc` (local only, not pushed). Task: profile the
node-position precalculation, convert to Rust, target ≥100% (2×) speedup.

## What the precalc was written in

TypeScript running in a Web Worker (`src/workers/force3d.worker.ts`), using the
**`d3-force-3d`** JS library for the force simulation. The hot path is
`simulation.tick()`, dominated by `forceManyBody` (Barnes-Hut octree, ~75%) and
`forceCollide` (~24%) — see `benchmarks/synthesis-results.md` profiling.

The precalc "core sim" = the repeated-tick solve on the degree-≥2 giant-component
core (~2.7k of 10k nodes): phase 1 converges collide-free, phase 2 runs 12
collide ticks. This is the part that scales with vault size and that the 2× target
applies to.

## Port

Reimplemented the four forces (manyBody, link, center, collide) + the d3
integration loop in Rust, faithful to `d3-force-3d` semantics:
- Barnes-Hut octree with `θ²=0.81`, `sqrt(4/8)` internal-node strength scaling,
  `|value|`-weighted centre of mass, `distanceMin²=1` clamp, LCG jiggle
- link spring with degree-bias, constant distance 60 / strength 0.5
- centre force (5% centroid pull), collide (r=12, equal-radius 0.5 split)
- per-tick: `alpha += (0-alpha)·0.055`; forces; `v *= 0.45`; `x += v`
- same phase-1 early-exit (mean |v| < 0.5 for 3 ticks) and 12-tick collide tail

Crate: `wasm/force-sim/` → `wasm32-unknown-unknown`, **37 KB** `.wasm`, no
wasm-bindgen (plain linear-memory marshalling). Prebuilt binary committed at
`src/workers/force_sim.wasm`; loaded in the worker via a `?url` import with a
**d3-force-3d fallback** if the wasm fails to load.

## Head-to-head benchmark (`scripts/bench-wasm.mjs`, Node v8, identical seeded inputs)

Core set: N=2673 nodes, M=6654 links. 3 runs each, median, after warm-up.

| engine | median ms | ticks (phase1/total) |
|--------|-----------|----------------------|
| JS (d3-force-3d) | **16321** | 71 / 83 |
| Rust/WASM        | **3197**  | 68 / 80 |

**Speedup ×5.11 (411% improvement)** — target was ×2 (100%). Near-identical tick
counts confirm equivalent dynamics, not a shortcut.

## Shape parity (`scripts/check-natural-shape.mjs`, same inputs)

| engine | composite | component (asym / cv / core-density) |
|--------|-----------|--------------------------------------|
| JS     | 64/100 GOOD | 2.12 / 0.49 / 0.432 |
| WASM   | 64/100 GOOD | 2.17 / 0.51 / 0.460 |

Identical composite, near-identical metrics → faithful port. (Core-only set scores
64; full layout with leaves attached scores 69 on the same basis.)

## In-browser verification (dev server, 10,047-node vault)

- worker console confirms `[precalc-engine] wasm` (not the d3 fallback)
- all 10,047 nodes load, zero console/page errors
- shape: separated gaussian clusters, collide-fluffed (not a blob)
- realtime gates intact (these still use the d3 streaming path, unchanged):
  - right-drag: moves during drag, persists after drop
  - note add/remove: +1 node live, reverted, no full relayout

## Integration impact

- **Users: none.** `.wasm` is a precompiled static asset the browser runs
  natively; prebuilt binary is committed so `npm run build`/`dev` need no Rust.
- **Rebuilding the sim** needs `rustup target add wasm32-unknown-unknown` then
  `cargo build --release --target wasm32-unknown-unknown` in `wasm/force-sim/`,
  then copy the `.wasm` to `src/workers/force_sim.wasm`.
- Fallback to d3-force-3d on any wasm load failure → worst case is "no speedup",
  never a broken graph.
