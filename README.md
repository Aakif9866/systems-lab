# Systems Lab

**Live:** https://aakif9866.github.io/systems-lab/

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

## Versions

### v1 — this release ✅
A static, $0 learning site. Ten systems explained with interactive diagrams, each paired with a **real TypeScript mini engine** that runs in the browser. Network, threads, clock and kernel are simulated, and each playground labels which parts. Includes a Phosphor+ theme with a black/white toggle, 77 engine tests, browser E2E and navigation checks, and is deployed on GitHub Pages.

### v2 — the real C++/Rust platform (planned)
Replace the in-browser mini engines with the production systems from the original spec (`docs/spec/prompt1.txt`, `docs/spec/prompt2.txt`), following the build plan in `docs/spec/plan.txt`.

**Scope**
- Ten real systems in **Rust** (distributed DB, async runtime, broker, proxy, container runtime) and **C++** (compiler, allocator, query engine, Redis engine, VCS), each independently buildable and tested.
- **Rust/Axum control plane** with email/password auth, experiment history and learning progress (PostgreSQL).
- **Execution agent** that runs each system in isolation: process sandbox on the hosted tier, Docker containers locally. All systems use one stdin/stdout JSONL contract and emit the same event envelope the v1 engines already use, so the playgrounds swap engines with minimal UI change.
- Live metrics, logs and traces (Prometheus/Grafana/OpenTelemetry), real benchmarks, failure injection.

**Prerequisites**
- Local: Rust (rustup), CMake, Docker Desktop with 8 GB of memory.
- Free accounts: Hugging Face Space (backend + systems), Neon (Postgres), Supabase Storage or Cloudflare R2, Grafana Cloud, Brevo (email).

**Order**
1. Foundation: Rust backend, auth, database, local Docker setup.
2. Execution framework and event protocol.
3. Distributed DB in Rust, using v1's Raft/LSM engine and tests as the reference.
4. Wire it into the site, validate isolation, first deploy.
5. The remaining nine systems on the same pattern. The container runtime goes last because it needs a dedicated Linux host.

**Carried over from v1:** engines as reference implementations, their 77 tests as specs to port, all content, diagrams, UI and the event format.

**Effort estimate:** about 1–2 months for steps 1–4, then 2–6 weeks per system.
