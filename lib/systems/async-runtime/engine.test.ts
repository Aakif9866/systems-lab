import { test } from "node:test";
import assert from "node:assert/strict";
import { Runtime, loadPreset } from "./engine.ts";

test("every preset runs to completion in async mode", () => {
  for (const p of ["io-heavy", "cpu-heavy", "imbalanced", "pipeline", "timers"] as const) {
    const rt = new Runtime({ workers: 4, stealing: true, mode: "async" });
    loadPreset(rt, p);
    const s = rt.run();
    assert.equal(s.counts.done, rt.tasks.size, p);
    assert.equal(s.deadlocked, false, p);
  }
});

test("async beats thread-per-task blocking on I/O-heavy work", () => {
  const a = new Runtime({ workers: 4, stealing: true, mode: "async" });
  const b = new Runtime({ workers: 4, stealing: true, mode: "sync" });
  loadPreset(a, "io-heavy");
  loadPreset(b, "io-heavy");
  const sa = a.run(), sb = b.run();
  assert.ok(sa.makespan * 3 < sb.makespan, `async ${sa.makespan} vs sync ${sb.makespan}`);
  // but on pure CPU work there's no free lunch
  const c = new Runtime({ workers: 4, stealing: true, mode: "async" });
  const d = new Runtime({ workers: 4, stealing: true, mode: "sync" });
  loadPreset(c, "cpu-heavy");
  loadPreset(d, "cpu-heavy");
  assert.ok(Math.abs(c.run().makespan - d.run().makespan) <= 4);
});

test("work stealing spreads an imbalanced queue and shortens the makespan", () => {
  const on = new Runtime({ workers: 4, stealing: true, mode: "async" });
  const off = new Runtime({ workers: 4, stealing: false, mode: "async" });
  loadPreset(on, "imbalanced");
  loadPreset(off, "imbalanced");
  const s1 = on.run(), s2 = off.run();
  assert.ok(s1.steals > 0);
  assert.equal(s2.steals, 0);
  assert.equal(s2.makespan, 24 * 8, "one worker does everything");
  assert.ok(s1.makespan < s2.makespan / 2.5, `${s1.makespan} vs ${s2.makespan}`);
});

test("bounded channel applies backpressure and never exceeds capacity", () => {
  const rt = new Runtime({ workers: 2, stealing: true, mode: "async" });
  loadPreset(rt, "pipeline");
  const s = rt.run();
  assert.equal(s.channelMax.jobs.max, 4);
  const producer = [...rt.tasks.values()].find((t) => t.name === "producer")!;
  assert.ok(producer.wakes > 5, "producer was parked on a full channel and woken");
});

test("polls only happen after wakes: a sleeping task is polled exactly twice", () => {
  const rt = new Runtime({ workers: 1, stealing: false, mode: "async" });
  const id = rt.spawn("sleepy", [{ kind: "sleep", ticks: 50 }]);
  rt.run();
  const t = rt.tasks.get(id)!;
  assert.equal(t.polls, 2, "poll → Pending, (reactor wakes) → poll → Ready");
  assert.equal(t.wakes, 1);
  assert.ok(t.doneAt! >= 50);
});

test("cancellation drops a task: no further polls, timers released", () => {
  const rt = new Runtime({ workers: 1, stealing: false, mode: "async" });
  const id = rt.spawn("long", [{ kind: "sleep", ticks: 1000 }, { kind: "compute", units: 5 }]);
  rt.step();
  rt.step();
  assert.equal(rt.tasks.get(id)!.state, "pending");
  assert.ok(rt.cancel(id));
  assert.equal(rt.timers.length, 0);
  const polls = rt.tasks.get(id)!.polls;
  rt.run();
  assert.equal(rt.tasks.get(id)!.polls, polls);
  assert.equal(rt.tasks.get(id)!.state, "cancelled");
});

test("sync mode with too few threads deadlocks on a channel pipeline, async does not", () => {
  const sync = new Runtime({ workers: 1, stealing: false, mode: "sync" });
  loadPreset(sync, "pipeline");
  assert.equal(sync.run().deadlocked, true);
  const asy = new Runtime({ workers: 1, stealing: false, mode: "async" });
  loadPreset(asy, "pipeline");
  assert.equal(asy.run().deadlocked, false);
});
