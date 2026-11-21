import { test } from "node:test";
import assert from "node:assert/strict";
import { RedisEngine, SkipList, encodeCommand, encodeReply, parseReply, parseRequest, runLoad } from "./engine.ts";
import { rng } from "../shared.ts";

test("RESP: requests parse incrementally across partial buffers", () => {
  const wire = encodeCommand(["SET", "héllo", "wörld"]) + encodeCommand(["GET", "héllo"]);
  assert.equal(parseRequest(wire.slice(0, 10)), null, "partial → need more bytes");
  const first = parseRequest(wire)!;
  assert.deepEqual(first.argv, ["SET", "héllo", "wörld"]);
  assert.deepEqual(parseRequest(wire.slice(first.used))!.argv, ["GET", "héllo"]);
  assert.deepEqual(parseRequest("PING\r\n")!.argv, ["PING"], "inline commands");
  assert.throws(() => parseRequest("*1\r\n+x\r\n"), /Protocol error/);
});

test("RESP: replies round-trip", () => {
  const r = { t: "arr" as const, v: [{ t: "bulk" as const, v: "a" }, { t: "int" as const, v: 3 }, { t: "bulk" as const, v: null }, { t: "err" as const, v: "ERR x" }] };
  assert.deepEqual(parseReply(encodeReply(r))!.r, r);
});

test("strings, counters, NX/XX and type errors", () => {
  const e = new RedisEngine();
  const c = e.connect();
  const run = (l: string) => e.command(c, l).reply;
  assert.deepEqual(run("SET a 1"), { t: "simple", v: "OK" });
  assert.deepEqual(run("INCRBY a 41"), { t: "int", v: 42 });
  assert.deepEqual(run("SET a 5 NX"), { t: "bulk", v: null });
  assert.deepEqual(run("SET b 5 XX"), { t: "bulk", v: null });
  assert.deepEqual(run("GET a"), { t: "bulk", v: "42" });
  run("LPUSH l x");
  assert.match((run("GET l") as { v: string }).v, /WRONGTYPE/);
  assert.match((run("NOPE") as { v: string }).v, /unknown command/);
});

test("TTL: lazy expiry on access and active expiry by sampling", () => {
  const e = new RedisEngine();
  const c = e.connect();
  e.command(c, "SET s v EX 1");
  assert.deepEqual(e.command(c, "TTL s").reply, { t: "int", v: 1 });
  e.advance(1001);
  assert.deepEqual(e.command(c, "GET s").reply, { t: "bulk", v: null });
  assert.equal(e.stats.expiredLazy, 1);
  for (let i = 0; i < 200; i++) e.command(c, `SET k${i} v PX 50`);
  e.advance(200);
  for (let i = 0; i < 20; i++) { e.loopOnce(); e.advance(100); }
  assert.ok(e.stats.expiredActive > 150, `active expiry removed ${e.stats.expiredActive}`);
  assert.ok(e.db.size < 50);
});

test("skiplist ranks and ranges match a sorted array on random data", () => {
  const sl = new SkipList(3);
  const r = rng(1);
  const model: [number, string][] = [];
  for (let i = 0; i < 500; i++) {
    const s = Math.floor(r() * 100), m = `m${i}`;
    sl.insert(s, m);
    model.push([s, m]);
    if (i % 7 === 0) { const k = Math.floor(r() * model.length); const [ds, dm] = model.splice(k, 1)[0]; assert.ok(sl.delete(ds, dm)); }
  }
  model.sort((a, b) => a[0] - b[0] || (a[1] < b[1] ? -1 : 1));
  assert.equal(sl.length, model.length);
  model.forEach(([s, m], i) => assert.equal(sl.rank(s, m), i));
  assert.deepEqual(sl.range(10, 20).map((x) => x.member), model.slice(10, 21).map((x) => x[1]));
});

test("sorted set commands", () => {
  const e = new RedisEngine();
  const c = e.connect();
  e.command(c, "ZADD lb 100 alice 50 bob 75 carol");
  e.command(c, "ZADD lb 120 bob");
  assert.deepEqual(e.command(c, "ZRANK lb bob").reply, { t: "int", v: 2 });
  const top = e.command(c, "ZREVRANGE lb 0 1").reply as { v: { v: string }[] };
  assert.deepEqual(top.v.map((x) => x.v), ["bob", "alice"]);
});

test("MULTI/EXEC queues then runs atomically; pub/sub delivers to subscribers", () => {
  const e = new RedisEngine();
  const a = e.connect("a"), b = e.connect("b");
  assert.deepEqual(e.command(a, "MULTI").reply, { t: "simple", v: "OK" });
  assert.deepEqual(e.command(a, "INCR n").reply, { t: "simple", v: "QUEUED" });
  e.command(a, "INCR n");
  const res = e.command(a, "EXEC").reply as { v: { v: number }[] };
  assert.deepEqual(res.v.map((x) => x.v), [1, 2]);

  e.command(b, "SUBSCRIBE news");
  assert.deepEqual(e.command(a, "PUBLISH news hi").reply, { t: "int", v: 1 });
  const msg = parseReply(e.clients.get(b)!.outbuf)!.r as { v: { v: string }[] };
  assert.deepEqual(msg.v.map((x) => x.v), ["message", "news", "hi"]);
  assert.match((e.command(b, "GET x").reply as { v: string }).v, /only \(UN\)SUBSCRIBE/);
});

test("load generator drives many clients through one loop", () => {
  const e = new RedisEngine();
  const r = runLoad(e, { clients: 20, commands: 5000, keys: 100, readRatio: 0.8, pipeline: 4 });
  assert.equal(r.commands, 5000);
  assert.ok(r.opsPerSec > 0);
  assert.equal(e.clients.size, 0);
});
