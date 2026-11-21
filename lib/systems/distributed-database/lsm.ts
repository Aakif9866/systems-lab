// LSM-tree storage engine: WAL → memtable → L0 SSTables → compaction into L1.
// Each SSTable has a bloom filter and sorted entries (binary search). Deletes are tombstones.
import { fnv1a } from "../shared.ts";

export class BloomFilter {
  bits: Uint8Array;
  m: number;
  k: number;
  constructor(expected: number, fpRate = 0.01) {
    this.m = Math.max(64, Math.ceil((-expected * Math.log(fpRate)) / Math.LN2 ** 2));
    this.k = Math.max(1, Math.round((this.m / Math.max(1, expected)) * Math.LN2));
    this.bits = new Uint8Array(Math.ceil(this.m / 8));
  }
  private *positions(key: string) {
    const h1 = fnv1a(key), h2 = (fnv1a(key, 0x5bd1e995) | 1) >>> 0; // double hashing (keep unsigned)
    for (let i = 0; i < this.k; i++) yield (h1 + i * h2) % this.m;
  }
  add(key: string) { for (const p of this.positions(key)) this.bits[p >> 3] |= 1 << (p & 7); }
  mightContain(key: string) { for (const p of this.positions(key)) if (!(this.bits[p >> 3] & (1 << (p & 7)))) return false; return true; }
}

export type KV = [string, string | null]; // null = tombstone
let sstSeq = 0;

export class SSTable {
  id: number;
  level: number;
  entries: KV[];
  bloom: BloomFilter;
  minKey: string;
  maxKey: string;
  bytes: number;
  constructor(level: number, entries: KV[]) {
    this.id = ++sstSeq;
    this.level = level;
    this.entries = entries;
    this.bloom = new BloomFilter(entries.length);
    for (const [k] of entries) this.bloom.add(k);
    this.minKey = entries[0]?.[0] ?? "";
    this.maxKey = entries[entries.length - 1]?.[0] ?? "";
    this.bytes = entries.reduce((s, [k, v]) => s + k.length + (v?.length ?? 0) + 8, 0);
  }
  find(key: string): KV | undefined {
    let lo = 0, hi = this.entries.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const k = this.entries[mid][0];
      if (k === key) return this.entries[mid];
      if (k < key) lo = mid + 1; else hi = mid - 1;
    }
    return undefined;
  }
}

export type WalRecord = { lsn: number; op: "put" | "del"; key: string; value?: string };
export type ReadStep = { where: string; result: "hit" | "miss" | "bloom-skip" | "range-skip" | "bloom-false-positive" };
export type LsmConfig = { memtableLimit: number; l0Limit: number; sstEntries: number };
export type LsmEvent = (type: string, payload: Record<string, unknown>) => void;

export class LSMStore {
  cfg: LsmConfig;
  memtable = new Map<string, string | null>();
  wal: WalRecord[] = [];
  l0: SSTable[] = []; // newest last
  l1: SSTable[] = []; // non-overlapping, sorted by key range
  lsn = 0;
  stats = { userBytes: 0, writtenBytes: 0, flushes: 0, compactions: 0, bloomSkips: 0, bloomFalsePositives: 0, sstProbes: 0, reads: 0 };
  onEvent: LsmEvent;

  constructor(cfg: Partial<LsmConfig> = {}, onEvent: LsmEvent = () => {}) {
    this.cfg = { memtableLimit: 16, l0Limit: 4, sstEntries: 32, ...cfg };
    this.onEvent = onEvent;
  }

  put(key: string, value: string) { this.write({ lsn: ++this.lsn, op: "put", key, value }); }
  delete(key: string) { this.write({ lsn: ++this.lsn, op: "del", key }); }

  private write(r: WalRecord) {
    this.wal.push(r); // 1. durable log first (write-ahead)
    this.onEvent("wal_append", { lsn: r.lsn, op: r.op, key: r.key });
    this.memtable.set(r.key, r.op === "put" ? r.value! : null); // 2. then memory
    this.stats.userBytes += r.key.length + (r.value?.length ?? 0);
    if (this.memtable.size >= this.cfg.memtableLimit) this.flush();
  }

  get(key: string): { value: string | null; path: ReadStep[] } {
    this.stats.reads++;
    const path: ReadStep[] = [];
    if (this.memtable.has(key)) { path.push({ where: "memtable", result: "hit" }); return { value: this.memtable.get(key)!, path }; }
    path.push({ where: "memtable", result: "miss" });
    const probe = (t: SSTable): KV | undefined => {
      if (key < t.minKey || key > t.maxKey) { path.push({ where: `L${t.level}#${t.id}`, result: "range-skip" }); return; }
      if (!t.bloom.mightContain(key)) { this.stats.bloomSkips++; path.push({ where: `L${t.level}#${t.id}`, result: "bloom-skip" }); return; }
      this.stats.sstProbes++;
      const e = t.find(key);
      if (!e) { this.stats.bloomFalsePositives++; path.push({ where: `L${t.level}#${t.id}`, result: "bloom-false-positive" }); return; }
      path.push({ where: `L${t.level}#${t.id}`, result: "hit" });
      return e;
    };
    for (let i = this.l0.length - 1; i >= 0; i--) { const e = probe(this.l0[i]); if (e) return { value: e[1], path }; }
    for (const t of this.l1) { if (key >= t.minKey && key <= t.maxKey) { const e = probe(t); return { value: e ? e[1] : null, path }; } }
    return { value: null, path };
  }

  flush() {
    if (this.memtable.size === 0) return;
    const entries = [...this.memtable.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
    const t = new SSTable(0, entries);
    this.l0.push(t);
    this.stats.writtenBytes += t.bytes;
    this.stats.flushes++;
    this.memtable.clear();
    const walRecords = this.wal.length;
    this.wal = []; // checkpoint: memtable contents are now durable in an SSTable
    this.onEvent("memtable_flush", { sst: t.id, entries: entries.length, walTruncated: walRecords });
    if (this.l0.length >= this.cfg.l0Limit) this.compact();
  }

  /** Merge all L0 tables with L1 (newest wins), drop tombstones at the bottom level, re-split. */
  compact() {
    const merged = new Map<string, string | null>();
    for (const t of this.l1) for (const [k, v] of t.entries) merged.set(k, v);
    for (const t of this.l0) for (const [k, v] of t.entries) merged.set(k, v); // oldest→newest overwrites
    const inputs = this.l0.length + this.l1.length;
    let dropped = 0;
    const live: KV[] = [...merged.entries()].filter(([, v]) => (v === null ? (dropped++, false) : true)).sort((a, b) => (a[0] < b[0] ? -1 : 1));
    const out: SSTable[] = [];
    for (let i = 0; i < live.length; i += this.cfg.sstEntries) out.push(new SSTable(1, live.slice(i, i + this.cfg.sstEntries)));
    this.l0 = [];
    this.l1 = out;
    this.stats.writtenBytes += out.reduce((s, t) => s + t.bytes, 0);
    this.stats.compactions++;
    this.onEvent("compaction", { inputs, outputs: out.length, tombstonesDropped: dropped, keys: live.length });
  }

  /** Power loss: memory is gone, the WAL and SSTables are on "disk". */
  crash() { this.memtable.clear(); }

  /** Recovery: replay the WAL into a fresh memtable. */
  recover(): number {
    for (const r of this.wal) this.memtable.set(r.key, r.op === "put" ? r.value! : null);
    this.onEvent("wal_replay", { records: this.wal.length });
    return this.wal.length;
  }

  scan(): Map<string, string> {
    const m = new Map<string, string | null>();
    for (const t of this.l1) for (const [k, v] of t.entries) m.set(k, v);
    for (const t of this.l0) for (const [k, v] of t.entries) m.set(k, v);
    for (const [k, v] of this.memtable) m.set(k, v);
    return new Map([...m].filter((e): e is [string, string] => e[1] !== null).sort((a, b) => (a[0] < b[0] ? -1 : 1)));
  }

  metrics() {
    const sstBytes = [...this.l0, ...this.l1].reduce((s, t) => s + t.bytes, 0);
    const liveBytes = [...this.scan()].reduce((s, [k, v]) => s + k.length + v.length + 8, 0);
    return {
      memtable: this.memtable.size, wal: this.wal.length, l0: this.l0.length, l1: this.l1.length, sstBytes,
      writeAmplification: this.stats.userBytes ? this.stats.writtenBytes / this.stats.userBytes : 0,
      spaceAmplification: liveBytes ? sstBytes / liveBytes : 0,
      ...this.stats,
    };
  }
}
