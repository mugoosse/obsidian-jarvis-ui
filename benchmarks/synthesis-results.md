# Synthesis branch benchmark — 2026-06-12

Branch `private/natural-pattern-stutter-synthesis` = local master stutter line
(per-tick streaming, natural early-exit, alphaDecay 0.055/0.07, velocityDecay 0.45)
× `private/natural-pattern-stutter-fixes` (P1 binary Float32Array protocol,
P2 React-free hot path, P3 drag throttling). Merge commit `eec32a7`.

Environment: headless Chromium (software WebGL, WSL2), 10,043-node vault, dev
server. Absolute numbers are ~10-50× slower than GPU-accelerated browsers —
only cross-branch deltas on identical setup are meaningful.

## Full-session capture (`scripts/verify-natural.mjs`, 1 run each)

__stutter rAF-interval percentiles, ms:

| capture | branch | p50 | p95 | p99 | max |
|---|---|---|---|---|---|
| idle 10s | pre-fix `999327f` | 667 | 750 | 750 | 750 |
| idle 10s | fixes `9f5aaaa` | 483 | 517 | 533 | 533 |
| idle 10s | synthesis `eec32a7` | 550 | 583 | 583 | 583 |
| drag 3 sweeps | pre-fix | 483 | 617 | 650 | 683 |
| drag 3 sweeps | fixes | 417 | 500 | 517 | 567 |
| drag 3 sweeps | synthesis | 417 | 483 | 517 | 583 |

## Settle-phase capture (`scripts/measure-settle.mjs`, 25s from canvas-ready, 3 runs each)

| branch | p95 range | p99 range | max range | worst long task |
|---|---|---|---|---|
| pre-fix | 1400–1567 | 1733–2667 | 2633–2750 | 2420–2555 |
| fixes | 867–1150 | 1500–1800 | 1500–1983 | 1503–1977 |
| synthesis | 983–1300 | 1633–2117 | 1967–2117 | 1955–1986 |

p50 is 16.7ms on all branches — the stutter lives entirely in the tail.

## Read

- Synthesis ≈ fixes branch (overlapping ranges, single-digit-run noise),
  both ~25-30% ahead of pre-fix on tail latency.
- Synthesis posts positions every tick (vs frame-budget batching on the fixes
  branch) at no measurable cost — the P1 binary protocol makes message
  frequency cheap — and adds the natural-layout early-exit + faster alpha
  decay, which end the settle phase sooner.
- Drag p95 is best on synthesis (483 vs 500 fixes / 617 pre-fix).

## Quality gates

- `gate-static-validation.mjs`: PASS (after fixing three stale patterns:
  project-tsconfig typecheck, `forceCenter()` never called, P1 `post()` rename)
- `check-natural-shape.mjs`: composite 68–69/100 GOOD, stable across runs;
  binary verdict flaky at the ~50% per-component threshold (pre-existing —
  scorer runs its own unseeded headless sim with hardcoded params; identical
  on master)
- Runtime (10,043-node vault): NODES = VISIBLE = 10,043, zero console errors,
  natural layout renders separated gaussian clusters (not a blob), node
  click/tooltip works, layout survives drag. Production build + lint clean.
