# Development status

_Last updated: 2026-11-21_

## Current phase

**Showcase site + 10 mini engines: complete.** The full C++/Rust platform (control plane, execution agents, Docker isolation) is out of scope for this site. It is documented on `/architecture` and `/roadmap`.

## Completed

- Static Next.js 16 site (App Router, Tailwind v4). 16 pages pre-rendered, with no backend.
- Phosphor+ theme: pure black, monospace, blinking caret, one colour per project. All text tokens pass WCAG AA (`pnpm contrast`).
- 10 mini engines in `lib/systems/`, each with tests and an interactive playground:
  - Distributed DB: LSM (WAL, memtable, SSTables, bloom, compaction) + Raft (election, replication, commit rule, truncation)
  - Container runtime: kernel model (pid/mnt/uts/net/user namespaces, cgroup memory/cpu/pids, OOM killer, veth)
  - Compiler: lexer, Pratt parser, type checker, constant folding + DCE, bytecode, VM, mark-sweep GC
  - Redis engine: streaming RESP, skiplist with spans, lazy + active expiry, pub/sub, MULTI/EXEC, load generator
  - Async runtime: poll/wake, work stealing, reactor, bounded channels, cancellation, deadlock detection
  - Message broker: ISR, high watermark, acks 0/1/all, min.insync.replicas, consumer groups, delivery audit
  - Memory allocator: boundary-tag free list (first/best fit), arena, slab, pool, fragmentation, leak/double-free detection
  - Query engine: SQL parser, pushdown, index selection, cost-based hash / sort-merge / nested-loop joins, vectorized execution
  - Reverse proxy: RR / least-conn / consistent hash, health checks, circuit breakers, retries, token bucket, pooling
  - Version control: git-exact SHA-1 blobs, nested trees, commits, branches, Myers diff, diff3 merge
- Architecture explorer: an SVG diagram per project, built from data, with click-to-inspect, path highlighting, request tracing and links to the implementing files.
- Every playground emits events in the standard envelope and has a filterable event timeline.

## Test results (2026-11-21)

| Check | Result |
|---|---|
| `pnpm test` (engine unit + property-style tests) | **77 / 77 pass** (~0.8 s) |
| `pnpm lint` | clean (0 errors, 0 warnings) |
| `pnpm contrast` | all text tokens ≥ 4.5:1 in both themes |
| `pnpm build` | 16 static pages, type-check clean |
| `pnpm e2e` (headless Chrome, real clicks/typing) | **12 / 12 pass** |
| `pnpm e2e:nav` (client nav, back, scroll, anchors, active nav, 404, white toggle) | **15 / 15 pass** |
| Live deployment smoke test (13 pages, favicon, 404, 2 playgrounds) | pass, 0 console errors |
| Responsive check (320 / 375 / 768 / 1024 / 1920 px, all 13 pages) | no horizontal overflow |

The highlights from the engine tests:
- Raft safety (one leader per term, log matching, identical state machines) holds under random kills, partitions and 5% packet loss across 6 seeds.
- The allocator never overlaps blocks, and freeing everything always coalesces back to one block.
- SQL results match answers computed by hand in plain JS. All 3 join algorithms agree.
- `hashObject("blob", "hello")` equals `git hash-object` output.

## Bugs found and fixed during testing

- Bloom filter false negatives: `h2 | 1` produced a signed int32, giving negative bit positions. Fixed with `>>> 0`.
- Async runtime: a sync-mode deadlock went undetected while a task was queued but every thread was blocked. Fixed.
- Allocator "fragment it" preset didn't actually fill the heap, so the demo's malloc succeeded. Fixed.
- Compiler editor gutter drifted from the code: a global `font: inherit` rule overrode `leading-6`. Removed.
- 320 px overflow from grids without a base column template. Fixed with `grid-cols-1`.

## Known limitations (by design)

- Network, threads, clock and disk are simulated inside the engines. Each playground says which.
- The container runtime is a model. Real namespaces and cgroups need a dedicated Linux host.
- The code explorer uses a plain editor and file references, not Monaco, to keep the site dependency-free.
- No user accounts or progress tracking, because the site is static by choice.

## Deployment status

**Live at https://aakif9866.github.io/systems-lab/**, deployed to GitHub Pages from the `gh-pages` branch (built with `BASE_PATH=/systems-lab`). Vercel also works from the repo root with no configuration.

## Next actionable tasks

1. Redeploy after changes: `BASE_PATH=/systems-lab pnpm build && touch out/.nojekyll`, then push `out/` to `gh-pages`.
2. Optional: add a GitHub Actions workflow running `pnpm check`.
3. Optional, the long-term spec: start Phase 1 of the real C++/Rust platform described on `/roadmap`.
