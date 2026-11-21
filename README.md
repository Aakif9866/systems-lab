# Systems Lab

Ten advanced systems explained from first principles, diagrammed from real code, and running as **mini engines in your browser**. It's a static Next.js site with no backend and no accounts, and it deploys to Vercel for free.

| # | System | Mini engine (runs in the tab) | Production language |
|---|---|---|---|
| 01 | Distributed Database | LSM tree (WAL, memtable, SSTables, bloom filters, compaction) under Raft consensus | Rust |
| 02 | Container Runtime | Kernel **model**: namespaces, cgroups v2, pivot_root, veth, OOM killer | Rust |
| 03 | Compiler & VM | Lexer → Pratt parser → type checker → optimizer → bytecode → stack VM + mark-sweep GC | C++ |
| 04 | Redis-like Engine | Streaming RESP, event loop, skiplist sorted sets, TTL expiry, pub/sub, MULTI/EXEC | C++ |
| 05 | Async Runtime | Futures/wakers, work-stealing scheduler, reactor, backpressure, cancellation | Rust |
| 06 | Message Broker | Partitions, ISR replication, high watermark, acks, consumer groups, delivery semantics | Rust |
| 07 | Memory Allocator | Boundary-tag malloc/free on an ArrayBuffer, arena, slab, pool | C++ |
| 08 | Query Engine | SQL → planner → pushdown + cost-based joins → vectorized columnar execution | C++ |
| 09 | Reverse Proxy | RR / least-conn / consistent hashing, health checks, circuit breakers, retries, rate limiting | Rust |
| 10 | Version Control | git-compatible SHA-1 objects, trees, commits, branches, Myers diff, 3-way merge | C++ |

Each playground labels honestly what is **real** (the algorithm) and what is **simulated** (network, threads, clock, kernel).

## Run it

```bash
pnpm install
pnpm dev            # http://localhost:3000
```

## Check it

```bash
pnpm test           # 77 engine tests (node:test, no test dependencies)
pnpm lint
pnpm contrast       # WCAG AA check for every text colour token
pnpm build          # static export to out/
pnpm e2e http://localhost:4173   # browser E2E against a served out/ (needs Chrome)
pnpm check          # test + lint + contrast + build
```

To serve the static build for E2E: `cd out && python3 -m http.server 4173`. The script uses `/Applications/Google Chrome.app` by default. Set `CHROME=/path/to/chrome` to use another browser.

## Deploy (free)

**GitHub Pages (current):** build with the repo name as base path and push `out/` to the `gh-pages` branch:

```bash
BASE_PATH=/systems-lab pnpm build && touch out/.nojekyll
# then commit out/ to the gh-pages branch and push (see scripts in DEVELOPMENT_STATUS.md)
```

**Vercel (alternative):** import the repository on [vercel.com](https://vercel.com). It works from the repo root with no environment variables.

## Layout

```
app/                    routes: / · /projects/[slug] (10 static pages) · /architecture · /roadmap
components/             Diagram (SVG architecture explorer), playgrounds/*, lab/kit (shared UI)
lib/systems/<slug>/     the ten engines: pure TypeScript, no React, each with *.test.ts
lib/projects.ts         content for every project (overview, internals, experiments, build plan)
lib/platform.ts         full-platform architecture, phases, learning paths
scripts/                contrast check, browser E2E
```

The engines emit events in the platform's standard execution envelope (`execution_id, project, event_type, timestamp, source, payload`). The production C++/Rust platform described on `/architecture` would use that same format.
