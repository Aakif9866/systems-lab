// Platform architecture content (prompt2 §1–8, prompt1 §5–12).
import type { DEdge, DNode } from "./projects";

export const layers = [
  { n: 1, name: "Frontend", where: "Vercel", tech: "Next.js · TypeScript · Tailwind · React Flow · Monaco · Recharts", does: ["Learning UI, architecture diagrams, code explorer", "Experiment configuration and execution controls", "Live metrics, logs and event timelines over WebSocket/SSE"], never: "Never executes native C++/Rust binaries." },
  { n: 2, name: "Control plane", where: "Linux compute", tech: "Rust · Axum · PostgreSQL · WebSockets", does: ["Auth, users, progress, experiment history", "Validates configs against each system's manifest", "Orchestrates executions, enforces quotas and timeouts, aggregates telemetry"], never: "Contains no project-specific logic — systems are described by manifests." },
  { n: 3, name: "Execution layer", where: "Isolated containers", tech: "Docker · one image per system · execution agent", does: ["Runs the real C++/Rust systems", "Standard lifecycle: start, stop, restart, reset, configure, execute, workload", "Streams events and metrics through the agent"], never: "Never exposes the Docker socket, a shell, or privileged containers to users." },
  { n: 4, name: "Observability", where: "Prometheus · Grafana · OTel", tech: "Structured JSON logs · traces · metrics", does: ["CPU, memory, network, disk per execution", "Throughput, latency percentiles, error rates", "Project-specific metrics (replication lag, poll counts, consumer lag…)"], never: "No fabricated or static metrics in production mode." },
  { n: 5, name: "Persistent storage", where: "Managed Postgres + object storage", tech: "PostgreSQL · S3-compatible storage", does: ["Users, experiment configs, execution history, benchmark summaries", "Large artifacts and reports in object storage"], never: "Postgres never substitutes for the storage engines being built." },
];

export const lifecycle = ["idle", "provisioning", "starting", "running", "stopping", "completed", "failed", "timed out"];

export const envelope = `{
  "execution_id": "exec-m3k9-12",
  "project": "distributed-database",
  "event_type": "leader_elected",
  "timestamp": "2026-11-21T10:00:00Z",
  "source": "node-2",
  "payload": { "term": 4, "votes": 3 }
}`;

export const contract = `trait SystemExecutor {
    async fn start(&self, config: Config) -> Result<ExecutionId>;
    async fn stop(&self, id: ExecutionId) -> Result<()>;
    async fn restart(&self, id: ExecutionId) -> Result<()>;
    async fn reset(&self, id: ExecutionId) -> Result<()>;
    async fn status(&self, id: ExecutionId) -> Result<Status>;
    async fn metrics(&self, id: ExecutionId) -> Result<Metrics>;
    async fn logs(&self, id: ExecutionId) -> Result<Vec<LogEntry>>;
}`;

export const wire = [
  { ch: "stdin", what: "newline-delimited JSON commands — {\"id\":1,\"cmd\":\"put\",\"args\":{…}}" },
  { ch: "stdout", what: "newline-delimited events in the envelope above, plus periodic metrics events" },
  { ch: "stderr", what: "structured JSON logs" },
  { ch: "ports", what: "network systems (DB nodes, Redis, broker, proxy) also listen inside the execution's private network" },
];

export const security = [
  "Authenticated users only; per-user quotas (concurrent + daily executions)",
  "Per-container CPU, memory and pids limits; read-only rootfs; all capabilities dropped; no-new-privileges",
  "Hard execution timeout + heartbeat lease: a closed browser stops the run within a minute",
  "Internal-only container networks — no egress",
  "Commands allowlisted per system manifest; no shell anywhere",
  "Privileged experiments (container runtime) only on a dedicated isolated host",
  "Audit log of every start, stop and failure injection",
];

export const archDiagram: { nodes: DNode[]; edges: DEdge[] } = {
  nodes: [
    { id: "browser", label: "browser", col: 0, row: 1, kind: "external", desc: "The learner. Talks HTTPS to Vercel and secure WebSockets to the control plane." },
    { id: "web", label: "Next.js (Vercel)", col: 1, row: 1, desc: "Layer 1. Static learning pages + live dashboards. Uses environment variables for backend URLs." },
    { id: "cp", label: "control plane", col: 2, row: 1, desc: "Layer 2. Rust/Axum. Auth, validation against manifests, orchestration, quotas, telemetry fan-out." },
    { id: "pg", label: "PostgreSQL", col: 2, row: 2, kind: "store", desc: "Layer 5. Users, experiments, executions, benchmarks, progress, audit log." },
    { id: "agent", label: "execution agent", col: 3, row: 1, desc: "Only component with the Docker socket. Starts containers with limits, reads stdout events, collects docker stats, reaps orphans." },
    { id: "sys", label: "system containers", col: 4, row: 1, kind: "boundary", desc: "Layer 3. One real C++/Rust binary per execution, speaking stdin/stdout JSONL." },
    { id: "obs", label: "Prometheus · Grafana · OTel", col: 3, row: 0, desc: "Layer 4. Metrics, traces and logs from the agent and control plane." },
    { id: "priv", label: "privileged host", col: 4, row: 2, kind: "boundary", desc: "Dedicated isolated Linux host for container-runtime experiments that need namespaces/cgroups." },
  ],
  edges: [
    { from: "browser", to: "web", label: "HTTPS" },
    { from: "web", to: "cp", label: "REST + WSS" },
    { from: "cp", to: "pg" },
    { from: "cp", to: "agent", label: "authenticated" },
    { from: "agent", to: "sys", label: "docker" },
    { from: "agent", to: "obs" },
    { from: "agent", to: "priv", label: "privileged only" },
  ],
};

export const phases = [
  { n: 1, name: "Foundation", what: "Monorepo, Next.js frontend, Rust control plane, Postgres, Docker-based local infrastructure." },
  { n: 2, name: "Execution framework", what: "Standard execution contract, event envelope, agent, logging, telemetry, lease + timeout cleanup." },
  { n: 3, name: "First system", what: "Distributed Database end-to-end: LSM engine, Raft, 5-node cluster, fault injection." },
  { n: 4, name: "Integrate", what: "All nine learning tabs wired to the real execution: overview → benchmarks." },
  { n: 5, name: "Validate", what: "Local execution, resource isolation, observability, first deployment." },
  { n: 6, name: "Remaining nine", what: "Allocator → VCS → Compiler → Query engine → Redis → Async runtime → Broker → Proxy → Container runtime." },
  { n: 7, name: "Deploy", what: "Frontend on Vercel, control plane + agents on Linux compute, managed Postgres." },
  { n: 8, name: "End-to-end", what: "Playwright journeys against the deployed platform for every system." },
];

export const definitionOfDone = [
  "Builds and runs independently (cargo build -p / cmake --preset)",
  "Unit + integration tests pass in CI",
  "Benchmarks produce real numbers",
  "Architecture diagram references real files (checked in CI)",
  "≥ 3 guided experiments run against the real binary",
  "Events drive the visualizer",
  "Docs cover components, data flow, lifecycle, storage, concurrency, failure handling, interfaces",
];

export const paths = [
  { name: "Systems Programming Foundations", slugs: ["memory-allocator", "compiler", "version-control"], why: "Memory, languages and data structures on disk — the base everything else stands on." },
  { name: "Networking & Concurrency", slugs: ["async-runtime", "redis-engine", "reverse-proxy"], why: "How servers handle thousands of connections without falling over." },
  { name: "Databases & Distributed Systems", slugs: ["query-engine", "distributed-database", "message-broker"], why: "Storing, querying and replicating data when machines fail." },
  { name: "Operating Systems & Infrastructure", slugs: ["container-runtime", "async-runtime", "reverse-proxy"], why: "The kernel features and infrastructure under every cloud deployment." },
];

export const thisSite = {
  title: "What this site actually is",
  points: [
    "A static Next.js site — no backend, no accounts, deployable for free.",
    "Ten mini engines written in TypeScript that really run in your browser: real algorithms, honest labels where the network, threads or kernel are simulated.",
    "77 automated tests check the engines' invariants (Raft safety, allocator integrity, SQL correctness against hand-computed answers, git-compatible hashes).",
    "The architecture and roadmap pages describe the full C++/Rust platform from the original spec, which this site explains but does not yet run.",
  ],
};
