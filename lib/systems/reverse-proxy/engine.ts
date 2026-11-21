// Mini reverse proxy / load balancer as a discrete-event simulation.
// Real: round-robin / least-connections / consistent hashing (vnode ring), active health checks,
// per-backend circuit breakers (closed → open → half-open), retries on another backend, token-bucket
// rate limiting, connection pooling, timeouts, latency percentiles.
// Simulated: the network and the backends themselves (latency/error knobs), on a virtual clock.
import { Emitter, fnv1a, percentile, rng } from "../shared.ts";

export type Strategy = "round-robin" | "least-connections" | "consistent-hash";
export type BreakerState = "closed" | "open" | "half-open";
export type Backend = {
  id: string; latency: number; errorRate: number; up: boolean; healthy: boolean;
  active: number; served: number; errors: number; idleConns: number; newConns: number; reused: number;
  breaker: { state: BreakerState; failures: number; openedAt: number; trialInFlight: boolean };
  hcFails: number; hcOks: number;
};
export type ProxyConfig = {
  strategy: Strategy; rps: number; retries: number; timeoutMs: number;
  rateCapacity: number; rateRefillPerSec: number; breakerThreshold: number; breakerCooldownMs: number;
  healthIntervalMs: number; poolSize: number; connectCostMs: number; vnodes: number; seed: number;
};
type Req = { id: number; key: string; start: number; attempt: number; tried: Set<string> };
type EvBody = { at: number } & ({ k: "arrival" } | { k: "done"; req: Req; backend: string; ok: boolean; reason: string } | { k: "health" });
type Ev = EvBody & { seq: number };

class Heap {
  a: Ev[] = [];
  private less = (x: Ev, y: Ev) => x.at < y.at || (x.at === y.at && x.seq < y.seq);
  push(e: Ev) {
    const a = this.a; a.push(e);
    for (let i = a.length - 1; i > 0; ) { const p = (i - 1) >> 1; if (!this.less(a[i], a[p])) break; [a[i], a[p]] = [a[p], a[i]]; i = p; }
  }
  pop(): Ev | undefined {
    const a = this.a; if (!a.length) return undefined;
    const top = a[0], last = a.pop()!;
    if (a.length) {
      a[0] = last;
      for (let i = 0; ; ) {
        const l = 2 * i + 1, r = l + 1; let m = i;
        if (l < a.length && this.less(a[l], a[m])) m = l;
        if (r < a.length && this.less(a[r], a[m])) m = r;
        if (m === i) break; [a[i], a[m]] = [a[m], a[i]]; i = m;
      }
    }
    return top;
  }
  peek() { return this.a[0]; }
}

export const DEFAULT_CONFIG: ProxyConfig = {
  strategy: "round-robin", rps: 200, retries: 1, timeoutMs: 800, rateCapacity: 100, rateRefillPerSec: 300,
  breakerThreshold: 5, breakerCooldownMs: 2000, healthIntervalMs: 500, poolSize: 8, connectCostMs: 15, vnodes: 64, seed: 3,
};

export class Proxy {
  cfg: ProxyConfig;
  time = 0;
  backends = new Map<string, Backend>();
  ring: { h: number; id: string }[] = [];
  emitter: Emitter;
  stats = { requests: 0, ok: 0, failed: 0, rateLimited: 0, noBackend: 0, retries: 0, timeouts: 0 };
  latencies: number[] = [];
  window: { t: number; ok: boolean; ms: number }[] = [];
  private q = new Heap();
  private seq = 0;
  private rand: () => number;
  private rrIdx = 0;
  private tokens: number;
  private lastRefill = 0;
  private reqId = 0;

  constructor(cfg: Partial<ProxyConfig> = {}, emitter = new Emitter("reverse-proxy", 500)) {
    this.cfg = { ...DEFAULT_CONFIG, ...cfg };
    this.emitter = emitter;
    this.rand = rng(this.cfg.seed);
    this.tokens = this.cfg.rateCapacity;
    this.schedule({ at: this.nextArrival(), k: "arrival" });
    this.schedule({ at: this.cfg.healthIntervalMs, k: "health" });
  }

  private schedule(e: EvBody) { this.q.push({ ...e, seq: ++this.seq }); }
  private nextArrival() { return this.time + (this.cfg.rps > 0 ? -Math.log(1 - this.rand()) * (1000 / this.cfg.rps) : 1e12); }

  addBackend(id: string, latency = 40, errorRate = 0) {
    this.backends.set(id, { id, latency, errorRate, up: true, healthy: true, active: 0, served: 0, errors: 0, idleConns: 0, newConns: 0, reused: 0, breaker: { state: "closed", failures: 0, openedAt: 0, trialInFlight: false }, hcFails: 0, hcOks: 0 });
    this.rebuildRing();
  }
  updateBackend(id: string, patch: Partial<Pick<Backend, "latency" | "errorRate" | "up">>) {
    const b = this.backends.get(id);
    if (b) Object.assign(b, patch);
  }
  removeBackend(id: string) { this.backends.delete(id); this.rebuildRing(); }
  rebuildRing() {
    this.ring = [...this.backends.keys()].flatMap((id) => Array.from({ length: this.cfg.vnodes }, (_, v) => ({ h: fnv1a(`${id}#${v}`), id }))).sort((a, b) => a.h - b.h);
  }
  setConfig(c: Partial<ProxyConfig>) {
    const vn = c.vnodes !== undefined && c.vnodes !== this.cfg.vnodes;
    this.cfg = { ...this.cfg, ...c };
    if (vn) this.rebuildRing();
  }

  /** Breaker gate. Open breakers move to half-open after the cooldown and admit one trial request. */
  private admits(b: Backend): boolean {
    const br = b.breaker;
    if (br.state === "open" && this.time - br.openedAt >= this.cfg.breakerCooldownMs) {
      br.state = "half-open"; br.trialInFlight = false;
      this.emitter.emit("breaker_half_open", b.id, {});
    }
    if (br.state === "open") return false;
    if (br.state === "half-open") return !br.trialInFlight;
    return true;
  }

  pick(key: string, exclude: Set<string> = new Set()): Backend | null {
    const ok = (b: Backend) => b.healthy && !exclude.has(b.id) && this.admits(b);
    const cands = [...this.backends.values()].filter(ok);
    if (!cands.length) return null;
    switch (this.cfg.strategy) {
      case "round-robin": return cands[this.rrIdx++ % cands.length];
      case "least-connections": return cands.reduce((m, b) => (b.active < m.active ? b : m));
      case "consistent-hash": {
        if (!this.ring.length) return null;
        const h = fnv1a(key);
        let lo = 0, hi = this.ring.length;
        while (lo < hi) { const mid = (lo + hi) >> 1; if (this.ring[mid].h < h) lo = mid + 1; else hi = mid; }
        for (let i = 0; i < this.ring.length; i++) {
          const b = this.backends.get(this.ring[(lo + i) % this.ring.length].id)!;
          if (cands.includes(b)) return b;
        }
        return null;
      }
    }
  }

  private dispatch(req: Req) {
    const b = this.pick(req.key, req.tried);
    if (!b) { this.finish(req, false, "503 no healthy backend"); this.stats.noBackend++; return; }
    req.tried.add(b.id);
    if (b.breaker.state === "half-open") b.breaker.trialInFlight = true;
    b.active++;
    let cost = 0;
    if (b.idleConns > 0) { b.idleConns--; b.reused++; } else { b.newConns++; cost = this.cfg.connectCostMs; }
    let dur: number, ok: boolean, reason: string;
    if (!b.up) { dur = cost + 1; ok = false; reason = "connection refused"; }
    else {
      dur = cost + b.latency * (0.5 + this.rand());
      ok = this.rand() >= b.errorRate;
      reason = ok ? "200" : "500";
      if (dur > this.cfg.timeoutMs) { dur = this.cfg.timeoutMs; ok = false; reason = "timeout"; }
    }
    this.schedule({ at: this.time + dur, k: "done", req, backend: b.id, ok, reason });
  }

  private finish(req: Req, ok: boolean, reason: string) {
    const ms = this.time - req.start;
    if (ok) this.stats.ok++; else this.stats.failed++;
    this.latencies.push(ms);
    if (this.latencies.length > 4000) this.latencies.splice(0, 1000);
    this.window.push({ t: this.time, ok, ms });
    if (!ok) this.emitter.emit("request_failed", "proxy", { req: req.id, reason, attempts: req.attempt + 1 });
  }

  private onDone(e: Extract<Ev, { k: "done" }>) {
    const b = this.backends.get(e.backend);
    if (b) {
      b.active--;
      if (b.up && b.idleConns < this.cfg.poolSize) b.idleConns++;
      const br = b.breaker;
      if (e.ok) {
        b.served++;
        if (br.state === "half-open") { br.state = "closed"; this.emitter.emit("breaker_closed", b.id, {}); }
        br.failures = 0;
      } else {
        b.errors++;
        if (e.reason === "timeout") this.stats.timeouts++;
        br.failures++;
        if (br.state === "half-open" || (br.state === "closed" && br.failures >= this.cfg.breakerThreshold)) {
          br.state = "open"; br.openedAt = this.time; br.trialInFlight = false;
          this.emitter.emit("breaker_open", b.id, { failures: br.failures });
        }
      }
    }
    if (!e.ok && e.req.attempt < this.cfg.retries) {
      e.req.attempt++;
      this.stats.retries++;
      this.emitter.emit("retry", "proxy", { req: e.req.id, after: e.backend, reason: e.reason });
      this.dispatch(e.req);
      return;
    }
    this.finish(e.req, e.ok, e.reason);
  }

  private onArrival() {
    this.stats.requests++;
    const elapsed = (this.time - this.lastRefill) / 1000;
    this.tokens = Math.min(this.cfg.rateCapacity, this.tokens + elapsed * this.cfg.rateRefillPerSec);
    this.lastRefill = this.time;
    const req: Req = { id: ++this.reqId, key: `client-${Math.floor(this.rand() * 500)}`, start: this.time, attempt: 0, tried: new Set() };
    if (this.tokens < 1) {
      this.stats.rateLimited++;
      this.window.push({ t: this.time, ok: false, ms: 0 });
      if (this.stats.rateLimited % 25 === 1) this.emitter.emit("rate_limited", "proxy", { total: this.stats.rateLimited });
    } else {
      this.tokens -= 1;
      this.dispatch(req);
    }
    this.schedule({ at: this.nextArrival(), k: "arrival" });
  }

  private onHealth() {
    for (const b of this.backends.values()) {
      if (b.up) { b.hcOks++; b.hcFails = 0; } else { b.hcFails++; b.hcOks = 0; }
      if (b.healthy && b.hcFails >= 2) { b.healthy = false; b.idleConns = 0; this.emitter.emit("backend_unhealthy", b.id, { checks: b.hcFails }); }
      if (!b.healthy && b.hcOks >= 2) { b.healthy = true; this.emitter.emit("backend_healthy", b.id, {}); }
    }
    this.schedule({ at: this.time + this.cfg.healthIntervalMs, k: "health" });
  }

  run(ms: number) {
    const until = this.time + ms;
    while (this.q.peek() && this.q.peek()!.at <= until) {
      const e = this.q.pop()!;
      this.time = e.at;
      if (e.k === "arrival") this.onArrival();
      else if (e.k === "done") this.onDone(e);
      else this.onHealth();
    }
    this.time = until;
    const cutoff = this.time - 1000;
    while (this.window.length && this.window[0].t < cutoff) this.window.shift();
  }

  metrics() {
    const lat = [...this.latencies].sort((a, b) => a - b);
    const w = this.window;
    return {
      time: this.time,
      throughput: w.filter((x) => x.ok).length, // per last 1s of virtual time
      errorRate: w.length ? w.filter((x) => !x.ok).length / w.length : 0,
      p50: percentile(lat, 50), p95: percentile(lat, 95), p99: percentile(lat, 99),
      ...this.stats,
      backends: [...this.backends.values()].map((b) => ({ id: b.id, served: b.served, errors: b.errors, active: b.active, healthy: b.healthy, up: b.up, breaker: b.breaker.state, poolReuse: b.reused + b.newConns ? b.reused / (b.reused + b.newConns) : 0, latency: b.latency, errorRate: b.errorRate })),
    };
  }
}
