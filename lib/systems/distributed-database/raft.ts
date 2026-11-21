// Raft consensus (Ongaro & Ousterhout) replicating commands into each node's LSM store.
// Real: randomized election timeouts, RequestVote with log up-to-date check, AppendEntries with
// prevLog consistency check + conflict truncation, commit only on current-term majority, no-op on
// election, persistent term/vote/log across crashes. Simulated: the network (tick-based delivery,
// configurable latency, partitions) and the clock.
// Not implemented (documented): snapshots/log compaction, membership changes, read leases.
import { Emitter, percentile, rng } from "../shared.ts";
import { LSMStore, type LsmConfig } from "./lsm.ts";

export type Cmd = { op: "put"; key: string; value: string } | { op: "del"; key: string } | { op: "noop" };
export type Entry = { term: number; index: number; cmd: Cmd; id: string };
export type Role = "follower" | "candidate" | "leader";

type Msg =
  | { t: "vote"; term: number; candidate: number; lastIndex: number; lastTerm: number }
  | { t: "voteReply"; term: number; granted: boolean }
  | { t: "append"; term: number; leader: number; prevIndex: number; prevTerm: number; entries: Entry[]; commit: number }
  | { t: "appendReply"; term: number; success: boolean; match: number };
type Packet = { from: number; to: number; at: number; msg: Msg };

export type RaftNode = {
  id: number; alive: boolean; role: Role;
  // persistent
  term: number; votedFor: number | null; log: Entry[];
  // volatile
  commitIndex: number; lastApplied: number; leaderId: number | null;
  nextIndex: number[]; matchIndex: number[]; votes: Set<number>;
  electionAt: number; heartbeatAt: number;
  store: LSMStore;
};

export type RaftConfig = { nodes: number; electionMin: number; electionMax: number; heartbeat: number; latencyMin: number; latencyMax: number; dropRate: number; batch: number; seed: number; lsm?: Partial<LsmConfig> };

export class RaftCluster {
  cfg: RaftConfig;
  nodes: RaftNode[];
  tick = 0;
  net: Packet[] = [];
  group: number[]; // partition id per node
  emitter: Emitter;
  leadersByTerm = new Map<number, number>();
  safetyViolations: string[] = [];
  pending = new Map<string, number>(); // entry id → submitted tick
  commitLatencies: number[] = [];
  stats = { messages: 0, dropped: 0, elections: 0, leaderChanges: 0, writes: 0, committed: 0, rejected: 0 };
  private rand: () => number;
  private seq = 0;

  constructor(cfg: Partial<RaftConfig> = {}, emitter = new Emitter("distributed-database", 600)) {
    this.cfg = { nodes: 5, electionMin: 10, electionMax: 20, heartbeat: 3, latencyMin: 1, latencyMax: 2, dropRate: 0, batch: 16, seed: 7, ...cfg };
    this.rand = rng(this.cfg.seed);
    this.emitter = emitter;
    this.group = new Array(this.cfg.nodes).fill(0);
    this.nodes = Array.from({ length: this.cfg.nodes }, (_, id) => ({
      id, alive: true, role: "follower" as Role, term: 0, votedFor: null, log: [], commitIndex: 0, lastApplied: 0, leaderId: null,
      nextIndex: [], matchIndex: [], votes: new Set<number>(), electionAt: 0, heartbeatAt: 0,
      store: new LSMStore(this.cfg.lsm, (type, payload) => this.emitter.emit(type, `node-${id}`, payload)),
    }));
    for (const n of this.nodes) this.resetElection(n);
  }

  private resetElection(n: RaftNode) {
    n.electionAt = this.tick + this.cfg.electionMin + Math.floor(this.rand() * (this.cfg.electionMax - this.cfg.electionMin + 1));
  }
  private lastIndex(n: RaftNode) { return n.log.length; }
  private termAt(n: RaftNode, i: number) { return i === 0 ? 0 : n.log[i - 1]?.term ?? -1; }

  private send(from: number, to: number, msg: Msg) {
    this.stats.messages++;
    const lat = this.cfg.latencyMin + Math.floor(this.rand() * (this.cfg.latencyMax - this.cfg.latencyMin + 1));
    this.net.push({ from, to, at: this.tick + lat, msg });
  }

  private becomeFollower(n: RaftNode, term: number) {
    if (term > n.term) { n.term = term; n.votedFor = null; }
    if (n.role !== "follower") this.emitter.emit("role_changed", `node-${n.id}`, { role: "follower", term: n.term });
    n.role = "follower";
  }

  private startElection(n: RaftNode) {
    n.role = "candidate";
    n.term++;
    n.votedFor = n.id;
    n.votes = new Set([n.id]);
    n.leaderId = null;
    this.stats.elections++;
    this.resetElection(n);
    this.emitter.emit("election_started", `node-${n.id}`, { term: n.term });
    for (const p of this.nodes) if (p.id !== n.id) this.send(n.id, p.id, { t: "vote", term: n.term, candidate: n.id, lastIndex: this.lastIndex(n), lastTerm: this.termAt(n, this.lastIndex(n)) });
    this.maybeWin(n);
  }

  private maybeWin(n: RaftNode) {
    if (n.role !== "candidate" || n.votes.size <= this.cfg.nodes / 2) return;
    n.role = "leader";
    n.leaderId = n.id;
    const prev = this.leadersByTerm.get(n.term);
    if (prev !== undefined && prev !== n.id) this.safetyViolations.push(`two leaders in term ${n.term}: ${prev} and ${n.id}`);
    this.leadersByTerm.set(n.term, n.id);
    this.stats.leaderChanges++;
    n.nextIndex = this.nodes.map(() => this.lastIndex(n) + 1);
    n.matchIndex = this.nodes.map(() => 0);
    this.emitter.emit("leader_elected", `node-${n.id}`, { term: n.term, votes: n.votes.size });
    this.appendLocal(n, { op: "noop" }); // lets the leader commit entries from earlier terms
    this.broadcast(n);
  }

  private appendLocal(n: RaftNode, cmd: Cmd): Entry {
    const e: Entry = { term: n.term, index: this.lastIndex(n) + 1, cmd, id: `e${++this.seq}` };
    n.log.push(e);
    n.matchIndex[n.id] = e.index;
    return e;
  }

  private broadcast(n: RaftNode) {
    n.heartbeatAt = this.tick + this.cfg.heartbeat;
    for (const p of this.nodes) {
      if (p.id === n.id) continue;
      const prevIndex = n.nextIndex[p.id] - 1;
      const entries = n.log.slice(prevIndex, prevIndex + this.cfg.batch);
      this.send(n.id, p.id, { t: "append", term: n.term, leader: n.id, prevIndex, prevTerm: this.termAt(n, prevIndex), entries, commit: n.commitIndex });
    }
  }

  private handle(n: RaftNode, from: number, m: Msg) {
    if (m.term > n.term) this.becomeFollower(n, m.term);
    switch (m.t) {
      case "vote": {
        const upToDate = m.lastTerm > this.termAt(n, this.lastIndex(n)) || (m.lastTerm === this.termAt(n, this.lastIndex(n)) && m.lastIndex >= this.lastIndex(n));
        const granted = m.term === n.term && (n.votedFor === null || n.votedFor === m.candidate) && upToDate;
        if (granted) { n.votedFor = m.candidate; this.resetElection(n); this.emitter.emit("vote_granted", `node-${n.id}`, { to: m.candidate, term: m.term }); }
        this.send(n.id, from, { t: "voteReply", term: n.term, granted });
        break;
      }
      case "voteReply":
        if (n.role === "candidate" && m.term === n.term && m.granted) { n.votes.add(from); this.maybeWin(n); }
        break;
      case "append": {
        if (m.term < n.term) { this.send(n.id, from, { t: "appendReply", term: n.term, success: false, match: 0 }); break; }
        if (n.role !== "follower") this.becomeFollower(n, m.term);
        n.leaderId = m.leader;
        this.resetElection(n);
        if (this.termAt(n, m.prevIndex) !== m.prevTerm) {
          // consistency check failed: leader will back up nextIndex
          this.send(n.id, from, { t: "appendReply", term: n.term, success: false, match: Math.min(m.prevIndex - 1, this.lastIndex(n)) });
          break;
        }
        for (const e of m.entries) {
          const existing = n.log[e.index - 1];
          if (existing && existing.term !== e.term) {
            const dropped = n.log.length - (e.index - 1);
            n.log.length = e.index - 1; // delete conflicting suffix
            this.emitter.emit("log_truncated", `node-${n.id}`, { from: e.index, dropped });
          }
          if (!n.log[e.index - 1]) n.log.push(e);
        }
        const match = m.prevIndex + m.entries.length;
        if (m.commit > n.commitIndex) n.commitIndex = Math.min(m.commit, match);
        if (m.entries.length) this.emitter.emit("append_entries", `node-${n.id}`, { from: m.leader, entries: m.entries.length, match });
        this.send(n.id, from, { t: "appendReply", term: n.term, success: true, match });
        break;
      }
      case "appendReply": {
        if (n.role !== "leader" || m.term !== n.term) break;
        if (m.success) {
          n.matchIndex[from] = Math.max(n.matchIndex[from], m.match);
          n.nextIndex[from] = n.matchIndex[from] + 1;
          this.advanceCommit(n);
        } else n.nextIndex[from] = Math.max(1, m.match + 1);
        break;
      }
    }
  }

  /** Commit the highest index replicated on a majority — only for entries from the current term (§5.4.2). */
  private advanceCommit(n: RaftNode) {
    for (let i = this.lastIndex(n); i > n.commitIndex; i--) {
      if (n.log[i - 1].term !== n.term) break;
      const replicas = n.matchIndex.filter((x) => x >= i).length;
      if (replicas > this.cfg.nodes / 2) {
        n.commitIndex = i;
        this.emitter.emit("commit", `node-${n.id}`, { index: i, replicas });
        break;
      }
    }
  }

  private apply(n: RaftNode) {
    while (n.lastApplied < n.commitIndex) {
      const e = n.log[n.lastApplied];
      n.lastApplied++;
      if (e.cmd.op === "put") n.store.put(e.cmd.key, e.cmd.value);
      else if (e.cmd.op === "del") n.store.delete(e.cmd.key);
      if (n.role === "leader" && this.pending.has(e.id)) {
        this.commitLatencies.push(this.tick - this.pending.get(e.id)!);
        if (this.commitLatencies.length > 2000) this.commitLatencies.splice(0, 500);
        this.pending.delete(e.id);
        this.stats.committed++;
      }
    }
  }

  step() {
    this.tick++;
    const due = this.net.filter((p) => p.at <= this.tick);
    this.net = this.net.filter((p) => p.at > this.tick);
    for (const p of due) {
      const to = this.nodes[p.to], from = this.nodes[p.from];
      if (!to.alive || !from.alive || this.group[p.to] !== this.group[p.from] || this.rand() < this.cfg.dropRate) { this.stats.dropped++; continue; }
      this.handle(to, p.from, p.msg);
    }
    for (const n of this.nodes) {
      if (!n.alive) continue;
      if (n.role === "leader") { if (this.tick >= n.heartbeatAt) this.broadcast(n); }
      else if (this.tick >= n.electionAt) this.startElection(n);
      this.apply(n);
    }
  }

  run(ticks: number) { for (let i = 0; i < ticks; i++) this.step(); }

  leader(): RaftNode | undefined {
    return this.nodes.filter((n) => n.alive && n.role === "leader").sort((a, b) => b.term - a.term)[0];
  }

  /** Client write: goes to the current leader, acknowledged once committed and applied. */
  write(key: string, value: string | null): { ok: boolean; id?: string; leader?: number; error?: string } {
    const l = this.leader();
    this.stats.writes++;
    if (!l) { this.stats.rejected++; return { ok: false, error: "no leader (election in progress or no majority)" }; }
    const e = this.appendLocal(l, value === null ? { op: "del", key } : { op: "put", key, value });
    this.pending.set(e.id, this.tick);
    this.emitter.emit("client_write", `node-${l.id}`, { key, index: e.index });
    return { ok: true, id: e.id, leader: l.id };
  }

  read(key: string, nodeId?: number) {
    const n = nodeId !== undefined ? this.nodes[nodeId] : this.leader();
    if (!n || !n.alive) return { error: "node unavailable", value: null, path: [], node: undefined, role: undefined };
    return { node: n.id, role: n.role, error: undefined, ...n.store.get(key) };
  }

  kill(id: number) {
    const n = this.nodes[id];
    if (!n.alive) return;
    n.alive = false;
    n.store.crash();
    this.emitter.emit("node_killed", `node-${id}`, { wasLeader: n.role === "leader", term: n.term });
  }

  restart(id: number) {
    const n = this.nodes[id];
    if (n.alive) return;
    n.alive = true;
    n.role = "follower";
    n.leaderId = null;
    n.votes = new Set();
    n.store.recover(); // WAL replay; SSTables survived; lastApplied is persisted with the store
    n.commitIndex = n.lastApplied;
    this.resetElection(n);
    this.emitter.emit("node_restarted", `node-${id}`, { term: n.term, logLength: n.log.length });
  }

  partition(groups: number[][]) {
    this.group = new Array(this.cfg.nodes).fill(-1);
    groups.forEach((g, gi) => g.forEach((id) => (this.group[id] = gi)));
    this.group = this.group.map((g, i) => (g === -1 ? 100 + i : g));
    this.emitter.emit("network_partition", "network", { groups });
  }

  heal() {
    this.group = new Array(this.cfg.nodes).fill(0);
    this.emitter.emit("network_healed", "network", {});
  }

  metrics() {
    const l = this.leader();
    const lat = [...this.commitLatencies].sort((a, b) => a - b);
    return {
      tick: this.tick, leader: l?.id ?? null, term: l?.term ?? Math.max(...this.nodes.map((n) => n.term)),
      commitP50: percentile(lat, 50), commitP99: percentile(lat, 99), inFlight: this.net.length,
      nodes: this.nodes.map((n) => ({
        id: n.id, alive: n.alive, role: n.role, term: n.term, log: n.log.length, commit: n.commitIndex, applied: n.lastApplied,
        lag: l ? this.lastIndex(l) - (l.matchIndex[n.id] ?? 0) : 0, partition: this.group[n.id], ...n.store.metrics(),
      })),
      ...this.stats,
    };
  }
}
