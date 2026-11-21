import { test } from "node:test";
import assert from "node:assert/strict";
import { Proxy } from "./engine.ts";

const make = (cfg = {}) => {
  const p = new Proxy({ rateCapacity: 1e9, rateRefillPerSec: 1e9, ...cfg });
  p.addBackend("a", 40);
  p.addBackend("b", 40);
  p.addBackend("c", 40);
  return p;
};
const served = (p: Proxy) => Object.fromEntries(p.metrics().backends.map((b) => [b.id, b.served]));

test("round-robin spreads load evenly", () => {
  const p = make({ strategy: "round-robin" });
  p.run(10_000);
  const s = Object.values(served(p));
  assert.ok(Math.max(...s) - Math.min(...s) <= 2, JSON.stringify(s));
});

test("least-connections sends more traffic to the fast backend", () => {
  const p = make({ strategy: "least-connections", rps: 400 });
  p.backends.get("a")!.latency = 10;
  p.backends.get("c")!.latency = 120;
  p.run(10_000);
  const s = served(p);
  assert.ok(s.a > s.b && s.b > s.c, JSON.stringify(s));
});

test("consistent hashing: same key → same backend; removing a node remaps ~1/N keys", () => {
  const p = make({ strategy: "consistent-hash", vnodes: 100 });
  const keys = Array.from({ length: 2000 }, (_, i) => `client-${i}`);
  const before = new Map(keys.map((k) => [k, p.pick(k)!.id]));
  assert.equal(p.pick("client-7")!.id, before.get("client-7"));
  p.removeBackend("b");
  const moved = keys.filter((k) => p.pick(k)!.id !== before.get(k));
  assert.ok(moved.every((k) => before.get(k) === "b"), "only keys owned by the removed node move");
  assert.ok(moved.length > 400 && moved.length < 950, `moved ${moved.length}/2000`);
});

test("circuit breaker opens on a failing backend, then half-opens and closes when it recovers", () => {
  const p = make({ strategy: "round-robin", retries: 0, breakerThreshold: 5, breakerCooldownMs: 1000 });
  p.backends.get("b")!.errorRate = 1;
  p.run(2000);
  assert.equal(p.backends.get("b")!.breaker.state, "open");
  const b = p.backends.get("b")!;
  // in-flight requests may still complete, and a cooldown may admit one half-open trial
  const ceiling = b.errors + b.active + 1;
  p.run(500);
  assert.ok(b.errors <= ceiling, `no regular traffic while open (${b.errors} <= ${ceiling})`);
  p.backends.get("b")!.errorRate = 0;
  p.run(3000);
  assert.equal(p.backends.get("b")!.breaker.state, "closed");
  assert.ok(p.emitter.events.some((e) => e.event_type === "breaker_half_open"));
});

test("health checks eject a dead backend; retries hide its failures from clients", () => {
  const noRetry = make({ retries: 0 });
  const withRetry = make({ retries: 2 });
  for (const p of [noRetry, withRetry]) { p.run(1000); p.backends.get("a")!.up = false; p.run(3000); }
  assert.equal(withRetry.backends.get("a")!.healthy, false);
  assert.ok(withRetry.stats.failed < noRetry.stats.failed / 3, `${withRetry.stats.failed} vs ${noRetry.stats.failed}`);
  assert.ok(withRetry.stats.retries > 0);
});

test("token bucket caps admitted throughput", () => {
  const p = new Proxy({ rps: 1000, rateCapacity: 20, rateRefillPerSec: 100 });
  p.addBackend("a", 5);
  p.run(10_000);
  const admitted = p.stats.requests - p.stats.rateLimited;
  assert.ok(admitted <= 100 * 10 + 20 + 5, `admitted ${admitted}`);
  assert.ok(p.stats.rateLimited > 7000);
});

test("connection pool reuses connections and percentiles are ordered", () => {
  const p = make();
  p.run(5000);
  const m = p.metrics();
  assert.ok(m.backends.every((b) => b.poolReuse > 0.8));
  assert.ok(m.p50 <= m.p95 && m.p95 <= m.p99);
});
