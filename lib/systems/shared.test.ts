import { test } from "node:test";
import assert from "node:assert/strict";
import { Emitter, percentile } from "./shared.ts";

test("emitter keeps rare events when routine ones flood the buffer", () => {
  const e = new Emitter("t", 100);
  e.emit("leader_elected", "node-1");
  for (let i = 0; i < 1000; i++) e.emit("wal_append", "node-1", { i });
  assert.equal(e.events.length, 100);
  assert.ok(e.events.some((x) => x.event_type === "leader_elected"));
  assert.equal(e.events[e.events.length - 1].payload.i, 999);
});

test("percentile picks nearest-rank values", () => {
  const xs = Array.from({ length: 100 }, (_, i) => i + 1);
  assert.equal(percentile(xs, 50), 50);
  assert.equal(percentile(xs, 99), 99);
  assert.equal(percentile([], 50), 0);
});
