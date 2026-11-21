// Mini Redis-like engine: streaming RESP2 parser/encoder, single-threaded event loop over many
// clients, strings/lists/sorted sets (real skiplist with spans), TTL with lazy + active expiry
// (Redis's sampling algorithm), pub/sub and MULTI/EXEC.
// Simulated: the network. Client bytes are appended to per-client input buffers instead of sockets.
import { Emitter, now, rng } from "../shared.ts";

// ---------------- RESP ----------------
export type Reply =
  | { t: "simple"; v: string }
  | { t: "err"; v: string }
  | { t: "int"; v: number }
  | { t: "bulk"; v: string | null }
  | { t: "arr"; v: Reply[] | null };

const enc = new TextEncoder();
const blen = (s: string) => enc.encode(s).length;

export function encodeReply(r: Reply): string {
  switch (r.t) {
    case "simple": return `+${r.v}\r\n`;
    case "err": return `-${r.v}\r\n`;
    case "int": return `:${r.v}\r\n`;
    case "bulk": return r.v === null ? "$-1\r\n" : `$${blen(r.v)}\r\n${r.v}\r\n`;
    case "arr": return r.v === null ? "*-1\r\n" : `*${r.v.length}\r\n${r.v.map(encodeReply).join("")}`;
  }
}

export function encodeCommand(argv: string[]): string {
  return `*${argv.length}\r\n${argv.map((a) => `$${blen(a)}\r\n${a}\r\n`).join("")}`;
}

/** Parse one request from a (possibly partial) buffer. Returns null when more bytes are needed. */
export function parseRequest(buf: string): { argv: string[]; used: number } | null {
  if (buf.length === 0) return null;
  if (buf[0] !== "*") {
    // inline command, e.g. "PING\r\n"
    const nl = buf.indexOf("\n");
    if (nl < 0) return null;
    return { argv: buf.slice(0, nl).replace(/\r$/, "").trim().split(/\s+/).filter(Boolean), used: nl + 1 };
  }
  let i = buf.indexOf("\r\n");
  if (i < 0) return null;
  const n = Number(buf.slice(1, i));
  if (!Number.isInteger(n) || n < 0 || n > 1024) throw new Error("Protocol error: invalid multibulk length");
  let pos = i + 2;
  const argv: string[] = [];
  for (let k = 0; k < n; k++) {
    if (buf[pos] === undefined) return null;
    if (buf[pos] !== "$") throw new Error(`Protocol error: expected '$', got '${buf[pos]}'`);
    i = buf.indexOf("\r\n", pos);
    if (i < 0) return null;
    const len = Number(buf.slice(pos + 1, i));
    if (!Number.isInteger(len) || len < 0) throw new Error("Protocol error: invalid bulk length");
    // len is in bytes; walk chars until byte length matches (handles UTF-8)
    let end = i + 2, bytes = 0;
    while (bytes < len && end < buf.length) bytes += blen(buf[end++]);
    if (bytes < len || buf.length < end + 2) return null;
    argv.push(buf.slice(i + 2, end));
    pos = end + 2;
  }
  return { argv, used: pos };
}

/** Parse one reply (for the client side / CLI). */
export function parseReply(buf: string, pos = 0): { r: Reply; used: number } | null {
  const i = buf.indexOf("\r\n", pos);
  if (i < 0) return null;
  const line = buf.slice(pos + 1, i);
  switch (buf[pos]) {
    case "+": return { r: { t: "simple", v: line }, used: i + 2 };
    case "-": return { r: { t: "err", v: line }, used: i + 2 };
    case ":": return { r: { t: "int", v: Number(line) }, used: i + 2 };
    case "$": {
      const n = Number(line);
      if (n < 0) return { r: { t: "bulk", v: null }, used: i + 2 };
      let end = i + 2, bytes = 0;
      while (bytes < n && end < buf.length) bytes += blen(buf[end++]);
      if (bytes < n) return null;
      return { r: { t: "bulk", v: buf.slice(i + 2, end) }, used: end + 2 };
    }
    case "*": {
      const n = Number(line);
      if (n < 0) return { r: { t: "arr", v: null }, used: i + 2 };
      const items: Reply[] = [];
      let p = i + 2;
      for (let k = 0; k < n; k++) {
        const sub = parseReply(buf, p);
        if (!sub) return null;
        items.push(sub.r);
        p = sub.used;
      }
      return { r: { t: "arr", v: items }, used: p };
    }
  }
  throw new Error("bad reply");
}

export function formatReply(r: Reply, indent = ""): string {
  switch (r.t) {
    case "simple": return r.v;
    case "err": return `(error) ${r.v}`;
    case "int": return `(integer) ${r.v}`;
    case "bulk": return r.v === null ? "(nil)" : JSON.stringify(r.v);
    case "arr": return r.v === null ? "(nil)" : r.v.length === 0 ? "(empty array)" : r.v.map((x, i) => `${indent}${i + 1}) ${formatReply(x, indent + "   ")}`).join("\n");
  }
}

// ---------------- skiplist (Redis zskiplist with spans for O(log n) rank) ----------------
type SLNode = { member: string; score: number; next: (SLNode | null)[]; span: number[] };
const MAX_LEVEL = 16;

export class SkipList {
  head: SLNode = { member: "", score: -Infinity, next: new Array(MAX_LEVEL).fill(null), span: new Array(MAX_LEVEL).fill(0) };
  level = 1;
  length = 0;
  private rand: () => number;
  constructor(seed = 1) { this.rand = rng(seed); }

  private lt(aS: number, aM: string, bS: number, bM: string) { return aS < bS || (aS === bS && aM < bM); }
  private randomLevel() { let l = 1; while (l < MAX_LEVEL && this.rand() < 0.25) l++; return l; }

  insert(score: number, member: string) {
    const update: SLNode[] = new Array(MAX_LEVEL);
    const rank = new Array(MAX_LEVEL).fill(0);
    let x = this.head;
    for (let i = this.level - 1; i >= 0; i--) {
      rank[i] = i === this.level - 1 ? 0 : rank[i + 1];
      while (x.next[i] && this.lt(x.next[i]!.score, x.next[i]!.member, score, member)) { rank[i] += x.span[i]; x = x.next[i]!; }
      update[i] = x;
    }
    const lvl = this.randomLevel();
    if (lvl > this.level) {
      for (let i = this.level; i < lvl; i++) { rank[i] = 0; update[i] = this.head; this.head.span[i] = this.length; }
      this.level = lvl;
    }
    const node: SLNode = { member, score, next: new Array(lvl).fill(null), span: new Array(lvl).fill(0) };
    for (let i = 0; i < lvl; i++) {
      node.next[i] = update[i].next[i];
      update[i].next[i] = node;
      node.span[i] = update[i].span[i] - (rank[0] - rank[i]);
      update[i].span[i] = rank[0] - rank[i] + 1;
    }
    for (let i = lvl; i < this.level; i++) update[i].span[i]++;
    this.length++;
  }

  delete(score: number, member: string): boolean {
    const update: SLNode[] = new Array(MAX_LEVEL);
    let x = this.head;
    for (let i = this.level - 1; i >= 0; i--) {
      while (x.next[i] && this.lt(x.next[i]!.score, x.next[i]!.member, score, member)) x = x.next[i]!;
      update[i] = x;
    }
    const target = x.next[0];
    if (!target || target.score !== score || target.member !== member) return false;
    for (let i = 0; i < this.level; i++) {
      if (update[i].next[i] === target) { update[i].span[i] += target.span[i] - 1; update[i].next[i] = target.next[i]; }
      else update[i].span[i]--;
    }
    while (this.level > 1 && !this.head.next[this.level - 1]) this.level--;
    this.length--;
    return true;
  }

  /** 0-based rank, or -1. */
  rank(score: number, member: string): number {
    let r = 0, x = this.head;
    for (let i = this.level - 1; i >= 0; i--) {
      while (x.next[i] && (this.lt(x.next[i]!.score, x.next[i]!.member, score, member) || (x.next[i]!.score === score && x.next[i]!.member === member))) { r += x.span[i]; x = x.next[i]!; }
      if (x !== this.head && x.member === member) return r - 1;
    }
    return -1;
  }

  /** Nodes with 0-based rank in [start, stop]. */
  range(start: number, stop: number): { member: string; score: number }[] {
    const out: { member: string; score: number }[] = [];
    let traversed = 0, x = this.head;
    for (let i = this.level - 1; i >= 0; i--) while (x.next[i] && traversed + x.span[i] <= start) { traversed += x.span[i]; x = x.next[i]!; }
    let n = x.next[0];
    for (let r = start; n && r <= stop; r++, n = n.next[0]) out.push({ member: n.member, score: n.score });
    return out;
  }

  levels(): number[] {
    // nodes per level, for visualization
    return Array.from({ length: this.level }, (_, i) => { let c = 0; for (let x = this.head.next[i]; x; x = x.next[i]) c++; return c; });
  }
}

export class ZSet {
  sl = new SkipList();
  dict = new Map<string, number>();
  add(member: string, score: number): boolean {
    const old = this.dict.get(member);
    if (old !== undefined) { if (old === score) return false; this.sl.delete(old, member); this.sl.insert(score, member); this.dict.set(member, score); return false; }
    this.sl.insert(score, member); this.dict.set(member, score); return true;
  }
  remove(member: string): boolean {
    const s = this.dict.get(member);
    if (s === undefined) return false;
    this.sl.delete(s, member); this.dict.delete(member); return true;
  }
}

// ---------------- engine ----------------
type Entry = { type: "string"; v: string } | { type: "list"; v: string[] } | { type: "zset"; v: ZSet };
export type Client = { id: number; name: string; inbuf: string; outbuf: string; multi: string[][] | null; subs: Set<string>; commands: number; sentAt: number[] };

const WRONGTYPE = "WRONGTYPE Operation against a key holding the wrong kind of value";

export class RedisEngine {
  db = new Map<string, Entry>();
  expires = new Map<string, number>(); // key -> absolute ms
  clients = new Map<number, Client>();
  channels = new Map<string, Set<number>>();
  simTime = 0; // ms
  stats = { commands: 0, hits: 0, misses: 0, expiredLazy: 0, expiredActive: 0, loopIterations: 0, bytesIn: 0, bytesOut: 0, execNs: 0 };
  latencies: number[] = []; // loop iterations a command waited
  emitter: Emitter;
  private nextClient = 1;
  private lastActiveExpire = 0;
  private rand = rng(99);

  constructor(emitter = new Emitter("redis-engine")) { this.emitter = emitter; }

  connect(name = `client-${this.nextClient}`): number {
    const id = this.nextClient++;
    this.clients.set(id, { id, name, inbuf: "", outbuf: "", multi: null, subs: new Set(), commands: 0, sentAt: [] });
    this.emitter.emit("client_connected", name, { id });
    return id;
  }

  disconnect(id: number) {
    const c = this.clients.get(id);
    if (!c) return;
    for (const ch of c.subs) this.channels.get(ch)?.delete(id);
    this.clients.delete(id);
    this.emitter.emit("client_disconnected", c.name, { id });
  }

  /** Bytes arrive from the "network". */
  receive(id: number, bytes: string) {
    const c = this.clients.get(id);
    if (!c) throw new Error("no such client");
    c.inbuf += bytes;
    c.sentAt.push(this.stats.loopIterations);
    this.stats.bytesIn += bytes.length;
  }

  private alive(key: string): Entry | undefined {
    const exp = this.expires.get(key);
    if (exp !== undefined && exp <= this.simTime) {
      this.db.delete(key); this.expires.delete(key); this.stats.expiredLazy++;
      this.emitter.emit("key_expired", "lazy", { key });
      return undefined;
    }
    return this.db.get(key);
  }

  /** Redis activeExpireCycle: sample 20 volatile keys; repeat while >25% were expired. */
  activeExpire() {
    for (let round = 0; round < 16; round++) {
      if (this.expires.size === 0) return;
      const keys = [...this.expires.keys()];
      let expired = 0;
      const sample = Math.min(20, keys.length);
      for (let i = 0; i < sample; i++) {
        const k = keys[Math.floor(this.rand() * keys.length)];
        const e = this.expires.get(k);
        if (e !== undefined && e <= this.simTime) { this.db.delete(k); this.expires.delete(k); expired++; this.stats.expiredActive++; this.emitter.emit("key_expired", "active", { key: k }); }
      }
      if (expired <= sample / 4) return;
    }
  }

  /** One event-loop iteration: "epoll_wait" → handle readable clients → flush → timers. */
  loopOnce(maxPerClient = 1): number {
    this.stats.loopIterations++;
    let handled = 0;
    const ready = [...this.clients.values()].filter((c) => c.inbuf.length > 0);
    if (ready.length) this.emitter.emit("loop_iteration", "event-loop", { ready: ready.length, iteration: this.stats.loopIterations });
    for (const c of ready) {
      for (let k = 0; k < maxPerClient; k++) {
        let parsed: ReturnType<typeof parseRequest>;
        try { parsed = parseRequest(c.inbuf); } catch (e) { this.write(c, { t: "err", v: (e as Error).message }); c.inbuf = ""; break; }
        if (!parsed) break;
        c.inbuf = c.inbuf.slice(parsed.used);
        if (parsed.argv.length === 0) continue;
        const sent = c.sentAt.shift();
        if (sent !== undefined) this.latencies.push(this.stats.loopIterations - sent);
        if (this.latencies.length > 5000) this.latencies.splice(0, 1000);
        const t = now();
        const reply = this.dispatch(c, parsed.argv);
        this.stats.execNs += (now() - t) * 1e6;
        if (reply) this.write(c, reply);
        handled++;
      }
    }
    if (this.simTime - this.lastActiveExpire >= 100) { this.lastActiveExpire = this.simTime; this.activeExpire(); }
    return handled;
  }

  advance(ms: number) { this.simTime += ms; }

  /** Read and clear everything the server has written to a client (what the socket would deliver). */
  takeOutput(id: number): string {
    const c = this.clients.get(id);
    if (!c) return "";
    const out = c.outbuf;
    c.outbuf = "";
    return out;
  }

  private write(c: Client, r: Reply) {
    const s = encodeReply(r);
    c.outbuf += s;
    this.stats.bytesOut += s.length;
  }

  /** Convenience for the CLI: send a command line, run the loop, decode the reply. */
  command(id: number, line: string): { raw: string; reply: Reply; request: string } {
    const argv = line.match(/"[^"]*"|\S+/g)?.map((s) => s.replace(/^"|"$/g, "")) ?? [];
    const request = encodeCommand(argv);
    const c = this.clients.get(id)!;
    c.outbuf = "";
    this.receive(id, request);
    while (c.inbuf.length) if (this.loopOnce() === 0) break;
    const raw = c.outbuf;
    const parsed = parseReply(raw);
    c.outbuf = parsed ? raw.slice(parsed.used) : "";
    return { raw, reply: parsed?.r ?? { t: "err", v: "no reply" }, request };
  }

  private dispatch(c: Client, argv: string[]): Reply | null {
    const cmd = argv[0].toUpperCase();
    c.commands++;
    this.stats.commands++;
    if (c.multi && !["EXEC", "DISCARD", "MULTI", "WATCH"].includes(cmd)) { c.multi.push(argv); return { t: "simple", v: "QUEUED" }; }
    if (c.subs.size && !["SUBSCRIBE", "UNSUBSCRIBE", "PING"].includes(cmd)) return { t: "err", v: `ERR Can't execute '${argv[0]}': only (UN)SUBSCRIBE / PING allowed in this context` };
    this.emitter.emit("command", c.name, { argv: argv.slice(0, 4) });
    return this.exec(c, cmd, argv.slice(1));
  }

  private exec(c: Client, cmd: string, a: string[]): Reply {
    const arity = (n: number, exact = true) => (exact ? a.length !== n : a.length < n);
    const wrong = { t: "err" as const, v: `ERR wrong number of arguments for '${cmd.toLowerCase()}' command` };
    const int = (s: string) => { const n = Number(s); return Number.isInteger(n) ? n : null; };
    const getType = <T extends Entry["type"]>(k: string, t: T) => {
      const e = this.alive(k);
      if (!e) { this.stats.misses++; return null; }
      this.stats.hits++;
      if (e.type !== t) throw new Error(WRONGTYPE);
      return e as Extract<Entry, { type: T }>;
    };
    try {
      switch (cmd) {
        case "PING": return a.length ? { t: "bulk", v: a[0] } : { t: "simple", v: "PONG" };
        case "ECHO": if (arity(1)) return wrong; return { t: "bulk", v: a[0] };
        case "SET": {
          if (arity(2, false)) return wrong;
          const [k, v] = a;
          let ttl: number | null = null, nx = false, xx = false;
          for (let i = 2; i < a.length; i++) {
            const o = a[i].toUpperCase();
            if (o === "EX" || o === "PX") { const n = int(a[++i] ?? ""); if (n === null || n <= 0) return { t: "err", v: "ERR invalid expire time in 'set' command" }; ttl = o === "EX" ? n * 1000 : n; }
            else if (o === "NX") nx = true;
            else if (o === "XX") xx = true;
            else return { t: "err", v: "ERR syntax error" };
          }
          const exists = !!this.alive(k);
          if ((nx && exists) || (xx && !exists)) return { t: "bulk", v: null };
          this.db.set(k, { type: "string", v });
          if (ttl !== null) this.expires.set(k, this.simTime + ttl); else this.expires.delete(k);
          return { t: "simple", v: "OK" };
        }
        case "GET": { if (arity(1)) return wrong; const e = getType(a[0], "string"); return { t: "bulk", v: e ? e.v : null }; }
        case "DEL": { if (arity(1, false)) return wrong; let n = 0; for (const k of a) if (this.alive(k)) { this.db.delete(k); this.expires.delete(k); n++; } return { t: "int", v: n }; }
        case "EXISTS": return { t: "int", v: a.filter((k) => this.alive(k)).length };
        case "INCR": case "DECR": case "INCRBY": case "DECRBY": {
          const by = cmd === "INCR" ? 1 : cmd === "DECR" ? -1 : (int(a[1] ?? "") ?? NaN) * (cmd === "DECRBY" ? -1 : 1);
          if (Number.isNaN(by) || a.length !== (cmd.endsWith("BY") ? 2 : 1)) return cmd.endsWith("BY") && a.length === 2 ? { t: "err", v: "ERR value is not an integer or out of range" } : wrong;
          const e = getType(a[0], "string");
          const cur = e ? int(e.v) : 0;
          if (cur === null) return { t: "err", v: "ERR value is not an integer or out of range" };
          this.db.set(a[0], { type: "string", v: String(cur + by) });
          return { t: "int", v: cur + by };
        }
        case "EXPIRE": case "PEXPIRE": {
          if (arity(2)) return wrong;
          const n = int(a[1]);
          if (n === null) return { t: "err", v: "ERR value is not an integer or out of range" };
          if (!this.alive(a[0])) return { t: "int", v: 0 };
          this.expires.set(a[0], this.simTime + (cmd === "EXPIRE" ? n * 1000 : n));
          return { t: "int", v: 1 };
        }
        case "TTL": case "PTTL": {
          if (arity(1)) return wrong;
          if (!this.alive(a[0])) return { t: "int", v: -2 };
          const e = this.expires.get(a[0]);
          if (e === undefined) return { t: "int", v: -1 };
          const ms = e - this.simTime;
          return { t: "int", v: cmd === "TTL" ? Math.ceil(ms / 1000) : ms };
        }
        case "PERSIST": return { t: "int", v: this.alive(a[0]) && this.expires.delete(a[0]) ? 1 : 0 };
        case "KEYS": {
          if (arity(1)) return wrong;
          const re = new RegExp("^" + a[0].replace(/[.+^${}()|\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$");
          return { t: "arr", v: [...this.db.keys()].filter((k) => this.alive(k) && re.test(k)).sort().map((k) => ({ t: "bulk", v: k })) };
        }
        case "TYPE": { const e = this.alive(a[0]); return { t: "simple", v: e ? e.type : "none" }; }
        case "DBSIZE": return { t: "int", v: this.db.size };
        case "FLUSHALL": this.db.clear(); this.expires.clear(); return { t: "simple", v: "OK" };
        case "LPUSH": case "RPUSH": {
          if (arity(2, false)) return wrong;
          let e = getType(a[0], "list");
          if (!e) { e = { type: "list", v: [] }; this.db.set(a[0], e); }
          for (const v of a.slice(1)) { if (cmd === "LPUSH") e.v.unshift(v); else e.v.push(v); }
          return { t: "int", v: e.v.length };
        }
        case "LPOP": case "RPOP": {
          const e = getType(a[0], "list");
          if (!e) return { t: "bulk", v: null };
          const v = cmd === "LPOP" ? e.v.shift()! : e.v.pop()!;
          if (e.v.length === 0) this.db.delete(a[0]);
          return { t: "bulk", v };
        }
        case "LRANGE": {
          if (arity(3)) return wrong;
          const e = getType(a[0], "list");
          if (!e) return { t: "arr", v: [] };
          const len = e.v.length;
          let s = int(a[1]) ?? 0, t = int(a[2]) ?? -1;
          if (s < 0) s = Math.max(0, len + s);
          if (t < 0) t = len + t;
          return { t: "arr", v: e.v.slice(s, t + 1).map((v) => ({ t: "bulk", v })) };
        }
        case "LLEN": { const e = getType(a[0], "list"); return { t: "int", v: e ? e.v.length : 0 }; }
        case "ZADD": {
          if (a.length < 3 || a.length % 2 === 0) return wrong;
          let e = getType(a[0], "zset");
          const pairs: [number, string][] = [];
          for (let i = 1; i < a.length; i += 2) { const s = Number(a[i]); if (Number.isNaN(s)) return { t: "err", v: "ERR value is not a valid float" }; pairs.push([s, a[i + 1]]); }
          if (!e) { e = { type: "zset", v: new ZSet() }; this.db.set(a[0], e); }
          let added = 0;
          for (const [s, m] of pairs) if (e.v.add(m, s)) added++;
          return { t: "int", v: added };
        }
        case "ZRANGE": case "ZREVRANGE": {
          if (a.length < 3) return wrong;
          const e = getType(a[0], "zset");
          if (!e) return { t: "arr", v: [] };
          const len = e.v.sl.length;
          let s = int(a[1]) ?? 0, t = int(a[2]) ?? -1;
          if (s < 0) s = Math.max(0, len + s);
          if (t < 0) t = len + t;
          t = Math.min(t, len - 1);
          if (s > t) return { t: "arr", v: [] };
          const withScores = a[3]?.toUpperCase() === "WITHSCORES";
          const items = cmd === "ZRANGE" ? e.v.sl.range(s, t) : e.v.sl.range(len - 1 - t, len - 1 - s).reverse();
          return { t: "arr", v: items.flatMap((x) => (withScores ? [{ t: "bulk" as const, v: x.member }, { t: "bulk" as const, v: String(x.score) }] : [{ t: "bulk" as const, v: x.member }])) };
        }
        case "ZRANK": { const e = getType(a[0], "zset"); const s = e?.v.dict.get(a[1]); return s === undefined ? { t: "bulk", v: null } : { t: "int", v: e!.v.sl.rank(s, a[1]) }; }
        case "ZSCORE": { const e = getType(a[0], "zset"); const s = e?.v.dict.get(a[1]); return { t: "bulk", v: s === undefined ? null : String(s) }; }
        case "ZREM": { const e = getType(a[0], "zset"); if (!e) return { t: "int", v: 0 }; const n = a.slice(1).filter((m) => e.v.remove(m)).length; if (!e.v.dict.size) this.db.delete(a[0]); return { t: "int", v: n }; }
        case "ZCARD": { const e = getType(a[0], "zset"); return { t: "int", v: e ? e.v.dict.size : 0 }; }
        case "PUBLISH": {
          if (arity(2)) return wrong;
          const subs = this.channels.get(a[0]) ?? new Set();
          for (const id of subs) {
            const sc = this.clients.get(id);
            if (sc) this.write(sc, { t: "arr", v: [{ t: "bulk", v: "message" }, { t: "bulk", v: a[0] }, { t: "bulk", v: a[1] }] });
          }
          this.emitter.emit("publish", c.name, { channel: a[0], receivers: subs.size });
          return { t: "int", v: subs.size };
        }
        case "SUBSCRIBE": {
          if (arity(1, false)) return wrong;
          const replies: Reply[] = [];
          for (const ch of a) {
            c.subs.add(ch);
            if (!this.channels.has(ch)) this.channels.set(ch, new Set());
            this.channels.get(ch)!.add(c.id);
            replies.push({ t: "bulk", v: "subscribe" }, { t: "bulk", v: ch }, { t: "int", v: c.subs.size });
          }
          return { t: "arr", v: replies };
        }
        case "UNSUBSCRIBE": {
          const chs = a.length ? a : [...c.subs];
          for (const ch of chs) { c.subs.delete(ch); this.channels.get(ch)?.delete(c.id); }
          return { t: "arr", v: [{ t: "bulk", v: "unsubscribe" }, { t: "int", v: c.subs.size }] };
        }
        case "MULTI": if (c.multi) return { t: "err", v: "ERR MULTI calls can not be nested" }; c.multi = []; return { t: "simple", v: "OK" };
        case "DISCARD": if (!c.multi) return { t: "err", v: "ERR DISCARD without MULTI" }; c.multi = null; return { t: "simple", v: "OK" };
        case "EXEC": {
          if (!c.multi) return { t: "err", v: "ERR EXEC without MULTI" };
          const queued = c.multi;
          c.multi = null;
          // single-threaded loop: nothing can interleave between these commands → atomic
          this.emitter.emit("transaction", c.name, { commands: queued.length });
          return { t: "arr", v: queued.map((argv) => this.exec(c, argv[0].toUpperCase(), argv.slice(1))) };
        }
        case "INFO": {
          const m = this.memory();
          const lines = [
            "# Server", `sim_time_ms:${this.simTime}`, `loop_iterations:${this.stats.loopIterations}`,
            "# Clients", `connected_clients:${this.clients.size}`,
            "# Memory", `used_memory_estimate:${m.bytes}`,
            "# Stats", `total_commands_processed:${this.stats.commands}`, `keyspace_hits:${this.stats.hits}`, `keyspace_misses:${this.stats.misses}`, `expired_keys_lazy:${this.stats.expiredLazy}`, `expired_keys_active:${this.stats.expiredActive}`,
            "# Keyspace", `db0:keys=${this.db.size},expires=${this.expires.size}`,
          ];
          return { t: "bulk", v: lines.join("\n") };
        }
        default: return { t: "err", v: `ERR unknown command '${cmd.toLowerCase()}'` };
      }
    } catch (e) {
      return { t: "err", v: (e as Error).message };
    }
  }

  /** Estimated memory (key + value bytes + fixed per-entry overhead); labelled as an estimate in the UI. */
  memory() {
    let bytes = 0;
    const byType = { string: 0, list: 0, zset: 0 };
    for (const [k, e] of this.db) {
      let b = 48 + k.length;
      if (e.type === "string") b += e.v.length;
      else if (e.type === "list") b += e.v.reduce((s, x) => s + x.length + 16, 0);
      else b += [...e.v.dict.keys()].reduce((s, x) => s + x.length + 40, 0);
      byType[e.type] += b;
      bytes += b;
    }
    return { bytes, byType, keys: this.db.size, volatile: this.expires.size };
  }
}

/** Concurrent-load generator: N clients pipelining random commands into the loop. */
export function runLoad(engine: RedisEngine, opts: { clients: number; commands: number; keys: number; readRatio: number; pipeline: number }, seed = 5) {
  const r = rng(seed);
  const ids = Array.from({ length: opts.clients }, (_, i) => engine.connect(`load-${i + 1}`));
  let remaining = opts.commands;
  const t0 = now();
  const before = engine.stats.commands;
  engine.latencies = [];
  while (remaining > 0) {
    for (const id of ids) {
      for (let p = 0; p < opts.pipeline && remaining > 0; p++, remaining--) {
        const key = `key:${Math.floor(r() * opts.keys)}`;
        const argv = r() < opts.readRatio ? ["GET", key] : r() < 0.5 ? ["SET", key, String(Math.floor(r() * 1e6))] : ["INCR", `ctr:${Math.floor(r() * 10)}`];
        engine.receive(id, encodeCommand(argv));
      }
    }
    while (engine.loopOnce(opts.pipeline) > 0) { /* drain */ }
    engine.advance(1);
  }
  const ms = now() - t0;
  for (const id of ids) engine.disconnect(id);
  const lat = [...engine.latencies].sort((a, b) => a - b);
  return { ms, commands: engine.stats.commands - before, opsPerSec: Math.round(((engine.stats.commands - before) / ms) * 1000), latencyIterations: lat };
}
