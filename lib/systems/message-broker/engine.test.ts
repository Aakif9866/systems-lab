import { test } from "node:test";
import assert from "node:assert/strict";
import { Cluster } from "./engine.ts";

const settle = (c: Cluster, n = 10) => { for (let i = 0; i < n; i++) c.step(); };

test("records with the same key keep their order in one partition", () => {
  const c = new Cluster();
  c.createTopic("orders", 4, 3);
  for (let i = 0; i < 40; i++) c.produce("orders", `user-${i % 5}`, `e${i}`, 1);
  settle(c);
  for (const p of c.topics.get("orders")!) {
    const log = p.logs.get(p.leader!)!;
    const byKey = new Map<string, number[]>();
    for (const r of log) byKey.set(r.key!, [...(byKey.get(r.key!) ?? []), Number(r.value.slice(1))]);
    for (const seq of byKey.values()) assert.deepEqual(seq, [...seq].sort((a, b) => a - b));
  }
  const keyPartitions = new Map<string, Set<number>>();
  for (const p of c.topics.get("orders")!) for (const r of p.logs.get(p.leader!)!) keyPartitions.set(r.key!, new Set([...(keyPartitions.get(r.key!) ?? []), p.id]));
  for (const s of keyPartitions.values()) assert.equal(s.size, 1, "a key maps to exactly one partition");
});

test("acks=all is only acknowledged once replicated to the ISR (HW passes the offset)", () => {
  const c = new Cluster();
  c.createTopic("t", 1, 3);
  const r = c.produce("t", "k", "v", "all");
  assert.equal(r.status, "pending");
  c.step();
  assert.ok(c.acked.has(r.id!));
  assert.equal(c.topics.get("t")![0].hw, 1);
});

test("acks=all survives leader failure; acks=1 can lose acknowledged data", () => {
  for (const acks of ["all", 1] as const) {
    const c = new Cluster();
    c.createTopic("t", 1, 3);
    settle(c, 2);
    const ids: string[] = [];
    for (let i = 0; i < 10; i++) ids.push(c.produce("t", "k", `v${i}`, acks).id!);
    if (acks === "all") settle(c, 3); // wait for acks
    c.killBroker(c.topics.get("t")![0].leader!); // leader dies immediately after acking (acks=1)
    settle(c, 5);
    const lost = c.durabilityAudit();
    if (acks === "all") assert.equal(lost.length, 0);
    else assert.ok(lost.length > 0, "acks=1 lost acknowledged records on failover");
  }
});

test("min.insync.replicas rejects acks=all when the ISR is too small; partition goes offline without ISR", () => {
  const c = new Cluster({ minIsr: 2 });
  c.createTopic("t", 1, 2);
  c.killBroker(1);
  assert.match(c.produce("t", "k", "v", "all").error!, /NOT_ENOUGH_REPLICAS/);
  assert.equal(c.produce("t", "k", "v", 1).status, "acked");
  c.killBroker(0);
  assert.equal(c.topics.get("t")![0].leader, null);
  assert.match(c.produce("t", "k", "v", 1).error!, /LEADER_NOT_AVAILABLE/);
  c.restartBroker(0);
  assert.equal(c.topics.get("t")![0].leader, 0, "last ISR member comes back as leader");
});

test("slow follower drops out of the ISR and rejoins after catching up", () => {
  const c = new Cluster({ replicaLagTicks: 2, fetchBatch: 1 });
  c.createTopic("t", 1, 2);
  for (let i = 0; i < 20; i++) c.produce("t", null, `v${i}`, 1);
  settle(c, 4);
  assert.equal(c.topics.get("t")![0].isr.has(1), false);
  settle(c, 30);
  assert.equal(c.topics.get("t")![0].isr.has(1), true);
});

test("rebalancing assigns every partition to exactly one live consumer", () => {
  const c = new Cluster();
  c.createTopic("t", 5, 2);
  c.createGroup("g");
  c.join("g", "c1");
  c.join("g", "c2");
  c.join("g", "c3");
  const all = [...c.groups.get("g")!.assignment.values()].flat().sort();
  assert.deepEqual(all, ["t/0", "t/1", "t/2", "t/3", "t/4"]);
  c.leave("g", "c2");
  assert.equal([...c.groups.get("g")!.assignment.values()].flat().length, 5);
  assert.equal(c.groups.get("g")!.generation, 4);
});

test("crash mid-batch: at-least-once → duplicates, no loss; at-most-once → loss, no duplicates", () => {
  for (const sem of ["at-least-once", "at-most-once"] as const) {
    const c = new Cluster();
    c.createTopic("t", 1, 3);
    c.createGroup("g", sem);
    c.join("g", "a");
    c.join("g", "b");
    for (let i = 0; i < 20; i++) c.produce("t", null, `v${i}`, 1);
    settle(c);
    const owner = [...c.groups.get("g")!.assignment].find(([, ps]) => ps.length)![0];
    c.consume("g", owner, 10, 4); // crash after 4 of 10
    const other = c.groups.get("g")!.members[0].id;
    while (c.consume("g", other, 10).processed > 0) { /* drain */ }
    const a = c.audit("g");
    if (sem === "at-least-once") { assert.equal(a.lost, 0); assert.ok(a.duplicates > 0); }
    else { assert.ok(a.lost > 0); assert.equal(a.duplicates, 0); }
  }
});
