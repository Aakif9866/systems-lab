// Mini Kafka-like broker. Real: partitioned append-only logs, key-hash partitioning, leader/follower
// replication with ISR + high watermark, acks=0/1/all, min.insync.replicas, leader election from ISR,
// follower truncation to HW, consumer groups with range assignment + rebalancing, committed offsets,
// at-most-once vs at-least-once delivery. Simulated: network/disk (in-memory logs, tick-based fetches).
import { Emitter, fnv1a } from "../shared.ts";

export type Rec = { offset: number; key: string | null; value: string; id: string };
export type Acks = 0 | 1 | "all";
export type Partition = {
  topic: string; id: number; replicas: number[]; leader: number | null; isr: Set<number>;
  logs: Map<number, Rec[]>; hw: number; caughtUpAt: Map<number, number>; epoch: number;
};
type Pending = { pkey: string; offset: number; id: string };
export type Consumer = { id: string; alive: boolean; positions: Map<string, number> };
export type Group = {
  id: string; generation: number; members: Consumer[]; assignment: Map<string, string[]>;
  committed: Map<string, number>; semantics: "at-most-once" | "at-least-once"; processed: Map<string, number>;
};
export type BrokerConfig = { brokers: number; replicaLagTicks: number; minIsr: number; fetchBatch: number; uncleanElection: boolean };

export class Cluster {
  cfg: BrokerConfig;
  alive: boolean[];
  topics = new Map<string, Partition[]>();
  groups = new Map<string, Group>();
  pending: Pending[] = [];
  acked = new Set<string>(); // message ids the producer was told were durable
  tick = 0;
  emitter: Emitter;
  stats = { produced: 0, ackedCount: 0, rejected: 0, fetched: 0, leaderChanges: 0, rebalances: 0, truncated: 0 };
  private msgSeq = 0;
  private rr = 0;

  constructor(cfg: Partial<BrokerConfig> = {}, emitter = new Emitter("message-broker", 500)) {
    this.cfg = { brokers: 3, replicaLagTicks: 4, minIsr: 2, fetchBatch: 4, uncleanElection: false, ...cfg };
    this.alive = new Array(this.cfg.brokers).fill(true);
    this.emitter = emitter;
  }

  createTopic(name: string, partitions: number, rf: number) {
    if (rf > this.cfg.brokers) throw new Error(`replication factor ${rf} > ${this.cfg.brokers} brokers`);
    if (this.topics.has(name)) throw new Error(`topic '${name}' exists`);
    const ps: Partition[] = [];
    for (let i = 0; i < partitions; i++) {
      const replicas = Array.from({ length: rf }, (_, r) => (i + r) % this.cfg.brokers);
      ps.push({ topic: name, id: i, replicas, leader: replicas[0], isr: new Set(replicas), logs: new Map(replicas.map((b) => [b, []])), hw: 0, caughtUpAt: new Map(replicas.map((b) => [b, 0])), epoch: 0 });
    }
    this.topics.set(name, ps);
    this.emitter.emit("topic_created", "controller", { topic: name, partitions, rf });
  }

  partition(pkey: string): Partition {
    const [t, i] = pkey.split("/");
    return this.topics.get(t)![Number(i)];
  }

  /** Producer send. Returns where the record landed and whether it's acknowledged yet. */
  produce(topic: string, key: string | null, value: string, acks: Acks = 1) {
    const ps = this.topics.get(topic);
    if (!ps) throw new Error(`unknown topic ${topic}`);
    const p = key === null ? ps[this.rr++ % ps.length] : ps[fnv1a(key) % ps.length];
    const pkey = `${topic}/${p.id}`;
    this.stats.produced++;
    if (p.leader === null || !this.alive[p.leader]) { this.stats.rejected++; return { pkey, status: "error" as const, error: "LEADER_NOT_AVAILABLE" }; }
    if (acks === "all" && p.isr.size < this.cfg.minIsr) { this.stats.rejected++; return { pkey, status: "error" as const, error: `NOT_ENOUGH_REPLICAS (isr=${p.isr.size} < min.insync.replicas=${this.cfg.minIsr})` }; }
    const log = p.logs.get(p.leader)!;
    const rec: Rec = { offset: log.length, key, value, id: `m${++this.msgSeq}` };
    log.push(rec);
    this.emitter.emit("record_appended", `broker-${p.leader}`, { partition: pkey, offset: rec.offset, key, acks });
    if (acks === "all") { this.pending.push({ pkey, offset: rec.offset, id: rec.id }); this.advanceHW(p); this.resolvePending(); }
    else { this.acked.add(rec.id); this.stats.ackedCount++; }
    const status = acks === "all" && !this.acked.has(rec.id) ? "pending" : "acked";
    return { pkey, offset: rec.offset, id: rec.id, status: status as "acked" | "pending" };
  }

  private advanceHW(p: Partition) {
    if (p.leader === null) return;
    const leos = [...p.isr].filter((b) => this.alive[b]).map((b) => p.logs.get(b)!.length);
    const hw = Math.min(...leos);
    if (hw > p.hw) {
      p.hw = hw;
      this.emitter.emit("high_watermark", `${p.topic}/${p.id}`, { hw });
    }
  }

  private resolvePending() {
    this.pending = this.pending.filter((x) => {
      const p = this.partition(x.pkey);
      if (p.hw > x.offset) { this.acked.add(x.id); this.stats.ackedCount++; return false; }
      return true;
    });
  }

  private elect(p: Partition, reason: string) {
    const candidates = p.replicas.filter((b) => this.alive[b] && p.isr.has(b));
    let leader: number | null = candidates[0] ?? null;
    if (leader === null && this.cfg.uncleanElection) {
      leader = p.replicas.find((b) => this.alive[b]) ?? null; // out-of-sync replica: committed data may be lost
      if (leader !== null) { p.isr = new Set([leader]); this.emitter.emit("unclean_election", `${p.topic}/${p.id}`, { leader }); }
    }
    const prev = p.leader;
    p.leader = leader;
    if (leader === null) { this.emitter.emit("partition_offline", `${p.topic}/${p.id}`, { reason }); return; }
    p.epoch++;
    this.stats.leaderChanges++;
    if (this.cfg.uncleanElection && !p.isr.has(leader)) p.isr = new Set([leader]);
    // new leader's log is authoritative; HW can only be what the new leader has
    p.hw = Math.min(p.hw, p.logs.get(leader)!.length);
    for (const b of p.replicas) if (b !== leader) this.truncate(p, b);
    this.emitter.emit("leader_elected", `${p.topic}/${p.id}`, { leader, prev, epoch: p.epoch, reason });
  }

  /** Follower truncates to the high watermark, then re-fetches from the leader. */
  private truncate(p: Partition, b: number) {
    const log = p.logs.get(b)!;
    if (log.length > p.hw) {
      const dropped = log.length - p.hw;
      log.length = p.hw;
      this.stats.truncated += dropped;
      this.emitter.emit("log_truncated", `broker-${b}`, { partition: `${p.topic}/${p.id}`, to: p.hw, dropped });
    }
  }

  killBroker(b: number) {
    if (!this.alive[b]) return;
    this.alive[b] = false;
    this.emitter.emit("broker_killed", `broker-${b}`, {});
    for (const ps of this.topics.values()) for (const p of ps) {
      if (!p.replicas.includes(b)) continue;
      const othersInIsr = [...p.isr].some((x) => x !== b && this.alive[x]);
      if (othersInIsr) p.isr.delete(b);
      if (p.leader === b) this.elect(p, `broker-${b} died`);
    }
  }

  restartBroker(b: number) {
    if (this.alive[b]) return;
    this.alive[b] = true;
    this.emitter.emit("broker_restarted", `broker-${b}`, {});
    for (const ps of this.topics.values()) for (const p of ps) {
      if (!p.replicas.includes(b)) continue;
      if (p.leader === null) this.elect(p, `broker-${b} returned`);
      else if (p.leader !== b) this.truncate(p, b);
    }
  }

  /** One replication round: followers fetch, ISR shrinks/expands, HW advances, acks resolve. */
  step() {
    this.tick++;
    for (const ps of this.topics.values()) for (const p of ps) {
      if (p.leader === null) continue;
      const leaderLog = p.logs.get(p.leader)!;
      p.caughtUpAt.set(p.leader, this.tick);
      for (const b of p.replicas) {
        if (b === p.leader || !this.alive[b]) continue;
        const log = p.logs.get(b)!;
        const n = Math.min(this.cfg.fetchBatch, leaderLog.length - log.length);
        if (n > 0) { log.push(...leaderLog.slice(log.length, log.length + n)); this.stats.fetched += n; }
        if (log.length === leaderLog.length) {
          p.caughtUpAt.set(b, this.tick);
          if (!p.isr.has(b)) { p.isr.add(b); this.emitter.emit("isr_expand", `${p.topic}/${p.id}`, { broker: b }); }
        }
      }
      for (const b of [...p.isr]) {
        if (b === p.leader) continue;
        if (!this.alive[b] || this.tick - (p.caughtUpAt.get(b) ?? 0) > this.cfg.replicaLagTicks) {
          p.isr.delete(b);
          this.emitter.emit("isr_shrink", `${p.topic}/${p.id}`, { broker: b, lagTicks: this.tick - (p.caughtUpAt.get(b) ?? 0) });
        }
      }
      this.advanceHW(p);
    }
    this.resolvePending();
  }

  // ---------------- consumer groups ----------------
  createGroup(id: string, semantics: Group["semantics"] = "at-least-once") {
    this.groups.set(id, { id, generation: 0, members: [], assignment: new Map(), committed: new Map(), semantics, processed: new Map() });
  }

  join(groupId: string, consumerId: string) {
    const g = this.groups.get(groupId)!;
    g.members.push({ id: consumerId, alive: true, positions: new Map() });
    this.rebalance(g, `${consumerId} joined`);
  }

  leave(groupId: string, consumerId: string, reason = "left") {
    const g = this.groups.get(groupId)!;
    g.members = g.members.filter((m) => m.id !== consumerId);
    this.rebalance(g, `${consumerId} ${reason}`);
  }

  /** Range assignor: per topic, contiguous partition ranges per sorted member. */
  private rebalance(g: Group, reason: string) {
    g.generation++;
    this.stats.rebalances++;
    g.assignment = new Map(g.members.map((m) => [m.id, []]));
    const members = [...g.members].sort((a, b) => a.id.localeCompare(b.id));
    if (members.length) for (const [t, ps] of this.topics) {
      const per = Math.floor(ps.length / members.length), extra = ps.length % members.length;
      let i = 0;
      members.forEach((m, mi) => {
        const n = per + (mi < extra ? 1 : 0);
        for (let k = 0; k < n; k++) g.assignment.get(m.id)!.push(`${t}/${i++}`);
      });
    }
    // every member restarts from the group's committed offsets
    for (const m of g.members) m.positions = new Map(g.assignment.get(m.id)!.map((pk) => [pk, g.committed.get(pk) ?? 0]));
    this.emitter.emit("group_rebalanced", g.id, { generation: g.generation, reason, assignment: Object.fromEntries(g.assignment) });
  }

  /**
   * Poll + process up to `max` records. `crashAfter` = consumer dies after processing that many
   * records (before finishing the batch). Commit timing decides at-most-once vs at-least-once.
   */
  consume(groupId: string, consumerId: string, max = 10, crashAfter?: number) {
    const g = this.groups.get(groupId)!;
    const m = g.members.find((x) => x.id === consumerId);
    if (!m) throw new Error(`${consumerId} is not in group ${groupId}`);
    const batch: { pkey: string; rec: Rec }[] = [];
    for (const pkey of g.assignment.get(consumerId) ?? []) {
      const p = this.partition(pkey);
      if (p.leader === null) continue;
      const log = p.logs.get(p.leader)!;
      const from = m.positions.get(pkey) ?? 0;
      // consumers only see committed (replicated) data: up to the high watermark
      for (let o = from; o < p.hw && batch.length < max; o++) batch.push({ pkey, rec: log[o] });
    }
    const commit = (upto: { pkey: string; rec: Rec }[]) => { for (const b of upto) g.committed.set(b.pkey, b.rec.offset + 1); };
    if (g.semantics === "at-most-once") commit(batch); // commit first, then process
    let processed = 0;
    for (const b of batch) {
      if (crashAfter !== undefined && processed >= crashAfter) {
        this.emitter.emit("consumer_crashed", consumerId, { afterRecords: processed });
        this.leave(groupId, consumerId, "crashed");
        return { processed, crashed: true };
      }
      g.processed.set(b.rec.id, (g.processed.get(b.rec.id) ?? 0) + 1);
      m.positions.set(b.pkey, b.rec.offset + 1);
      processed++;
    }
    if (g.semantics === "at-least-once") commit(batch); // process first, then commit
    if (batch.length) this.emitter.emit("records_consumed", consumerId, { count: processed, generation: g.generation });
    return { processed, crashed: false };
  }

  lag(groupId: string) {
    const g = this.groups.get(groupId)!;
    const out: Record<string, number> = {};
    for (const ps of this.topics.values()) for (const p of ps) out[`${p.topic}/${p.id}`] = p.hw - (g.committed.get(`${p.topic}/${p.id}`) ?? 0);
    return out;
  }

  /** Delivery audit for a group: acked records never processed (lost) and processed more than once. */
  audit(groupId: string) {
    const g = this.groups.get(groupId)!;
    let lost = 0, duplicates = 0;
    for (const id of this.acked) if (!g.processed.has(id)) lost++;
    for (const n of g.processed.values()) if (n > 1) duplicates += n - 1;
    return { lost, duplicates, processed: g.processed.size };
  }

  /** Acked records missing from the current leader's log (data loss from unsafe acks). */
  durabilityAudit() {
    const present = new Set<string>();
    for (const ps of this.topics.values()) for (const p of ps) if (p.leader !== null) for (const r of p.logs.get(p.leader)!) present.add(r.id);
    return [...this.acked].filter((id) => !present.has(id));
  }
}
