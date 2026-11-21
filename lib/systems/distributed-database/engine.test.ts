import { test } from "node:test";
import assert from "node:assert/strict";
import { BloomFilter, LSMStore } from "./lsm.ts";
import { RaftCluster } from "./raft.ts";
import { rng } from "../shared.ts";

test("bloom filter: no false negatives, low false-positive rate", () => {
  const b = new BloomFilter(1000, 0.01);
  for (let i = 0; i < 1000; i++) b.add(`k${i}`);
  for (let i = 0; i < 1000; i++) assert.ok(b.mightContain(`k${i}`));
  let fp = 0;
  for (let i = 0; i < 10000; i++) if (b.mightContain(`other${i}`)) fp++;
  assert.ok(fp / 10000 < 0.03, `fp rate ${fp / 10000}`);
});

test("LSM matches a Map model through flushes, compactions and deletes", () => {
  const s = new LSMStore({ memtableLimit: 8, l0Limit: 3, sstEntries: 10 });
  const model = new Map<string, string>();
  const r = rng(5);
  for (let i = 0; i < 2000; i++) {
    const k = `key${Math.floor(r() * 150)}`;
    if (r() < 0.2) { s.delete(k); model.delete(k); }
    else { const v = `v${i}`; s.put(k, v); model.set(k, v); }
  }
  for (let i = 0; i < 150; i++) assert.equal(s.get(`key${i}`).value, model.get(`key${i}`) ?? null, `key${i}`);
  assert.deepEqual([...s.scan()], [...model].sort((a, b) => (a[0] < b[0] ? -1 : 1)));
  const m = s.metrics();
  assert.ok(m.flushes > 0 && m.compactions > 0);
  assert.ok(m.writeAmplification > 1, "compaction rewrites data");
  for (let i = 1; i < s.l1.length; i++) assert.ok(s.l1[i - 1].maxKey < s.l1[i].minKey, "L1 tables don't overlap");
});

test("crash loses the memtable; WAL replay restores it", () => {
  const s = new LSMStore({ memtableLimit: 100 });
  s.put("a", "1");
  s.put("b", "2");
  s.delete("a");
  s.crash();
  assert.equal(s.get("b").value, null);
  assert.equal(s.recover(), 3);
  assert.equal(s.get("b").value, "2");
  assert.equal(s.get("a").value, null);
});

test("raft elects exactly one leader and replicates committed writes to every node", () => {
  const c = new RaftCluster({ seed: 1 });
  c.run(60);
  const l = c.leader();
  assert.ok(l, "a leader was elected");
  assert.equal(c.nodes.filter((n) => n.role === "leader").length, 1);
  for (let i = 0; i < 20; i++) c.write(`k${i}`, `v${i}`);
  c.run(30);
  for (const n of c.nodes) assert.equal(n.store.get("k19").value, "v19", `node ${n.id}`);
  assert.equal(c.stats.committed, 20);
  assert.deepEqual(c.safetyViolations, []);
});

test("killing the leader triggers a new election; committed data survives", () => {
  const c = new RaftCluster({ seed: 2 });
  c.run(60);
  for (let i = 0; i < 10; i++) c.write(`k${i}`, `v${i}`);
  c.run(20);
  const old = c.leader()!;
  c.kill(old.id);
  c.run(80);
  const nl = c.leader()!;
  assert.ok(nl && nl.id !== old.id && nl.term > old.term);
  assert.equal(c.read("k9").value, "v9");
  c.write("after", "x");
  c.run(20);
  c.restart(old.id);
  c.run(40);
  assert.equal(c.nodes[old.id].role, "follower");
  assert.equal(c.nodes[old.id].store.get("after").value, "x", "old leader catches up after restart");
  assert.deepEqual(c.safetyViolations, []);
});

test("minority partition cannot commit; majority keeps working; uncommitted minority writes are discarded on heal", () => {
  const c = new RaftCluster({ seed: 3 });
  c.run(60);
  const l = c.leader()!;
  const others = c.nodes.map((n) => n.id).filter((id) => id !== l.id);
  // old leader + 1 follower in the minority
  c.partition([[l.id, others[0]], others.slice(1)]);
  c.write("lost", "minority"); // goes to old leader (still thinks it leads)
  c.run(80);
  const majorityLeader = c.leader()!;
  assert.ok(others.slice(1).includes(majorityLeader.id));
  c.write("kept", "majority");
  c.run(20);
  assert.equal(c.nodes[l.id].store.get("lost").value, null, "minority write never committed");
  c.heal();
  c.run(80);
  for (const n of c.nodes) {
    assert.equal(n.store.get("kept").value, "majority", `node ${n.id}`);
    assert.equal(n.store.get("lost").value, null);
  }
  assert.equal(c.nodes.filter((n) => n.role === "leader").length, 1);
  assert.deepEqual(c.safetyViolations, []);
});

test("safety holds under random failures, partitions and message loss", () => {
  for (let seed = 10; seed < 16; seed++) {
    const c = new RaftCluster({ seed, dropRate: 0.05, latencyMax: 3 });
    const r = rng(seed);
    for (let t = 0; t < 600; t++) {
      if (r() < 0.3) c.write(`k${Math.floor(r() * 20)}`, `v${t}`);
      if (r() < 0.01) c.kill(Math.floor(r() * 5));
      if (r() < 0.02) c.restart(Math.floor(r() * 5));
      if (r() < 0.005) c.partition([[0, 1], [2, 3, 4]]);
      if (r() < 0.01) c.heal();
      c.step();
    }
    c.heal();
    for (let i = 0; i < 5; i++) c.restart(i);
    c.run(200);
    assert.deepEqual(c.safetyViolations, [], `seed ${seed}`);
    // state machine safety: all nodes applied the same prefix → identical stores
    const snap = (i: number) => JSON.stringify([...c.nodes[i].store.scan()]);
    const minApplied = Math.min(...c.nodes.map((n) => n.lastApplied));
    for (const n of c.nodes) for (let i = 0; i < minApplied; i++) assert.equal(n.log[i].id, c.nodes[0].log[i].id, `log matching seed ${seed}`);
    const leader = c.leader()!;
    c.write("final", "x");
    c.run(60);
    for (const n of c.nodes) assert.equal(snap(n.id), snap(leader.id), `seed ${seed} node ${n.id}`);
  }
});
