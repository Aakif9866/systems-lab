// Mini memory allocator: real allocators operating on real bytes in an ArrayBuffer.
// Layout of the free-list heap (boundary tags, 8-byte aligned payloads):
//   [pad 4B = sentinel] [hdr 4B | payload ... | ftr 4B] [hdr | ... | ftr] ... [epilogue 4B]
//   hdr/ftr word = blockSize | allocatedBit. blockSize includes hdr+ftr and is a multiple of 8.
import { Emitter, now, rng } from "../shared.ts";

export type Fit = "first" | "best";
export type Block = { addr: number; size: number; allocated: boolean; payload: number; requested?: number; label?: string };

const HDR = 4;
const MIN_BLOCK = 16;
const align8 = (n: number) => (n + 7) & ~7;

export class FreeListHeap {
  readonly size: number;
  readonly buf: ArrayBuffer;
  readonly view: DataView;
  readonly bytes: Uint8Array;
  fit: Fit;
  live = new Map<number, { requested: number; label: string; at: number }>();
  stats = { mallocs: 0, frees: 0, failed: 0, splits: 0, coalesces: 0, scanned: 0 };
  emitter?: Emitter;
  private clock = 0;

  constructor(size = 64 * 1024, fit: Fit = "first", emitter?: Emitter) {
    if (size % 8 !== 0 || size < 64) throw new Error("heap size must be a multiple of 8 and >= 64");
    this.size = size;
    this.fit = fit;
    this.emitter = emitter;
    this.buf = new ArrayBuffer(size);
    this.view = new DataView(this.buf);
    this.bytes = new Uint8Array(this.buf);
    this.reset();
  }

  setFit(fit: Fit): void {
    this.fit = fit;
  }

  reset(): void {
    this.bytes.fill(0);
    this.live.clear();
    this.stats = { mallocs: 0, frees: 0, failed: 0, splits: 0, coalesces: 0, scanned: 0 };
    this.view.setUint32(0, 0 | 1); // prologue sentinel: size 0, allocated
    const first = this.size - 8; // minus pad and epilogue
    this.setTags(4, first, false);
    this.view.setUint32(this.size - 4, 0 | 1); // epilogue
  }

  private word(addr: number) {
    const w = this.view.getUint32(addr);
    return { size: w & ~7, allocated: (w & 1) === 1 };
  }

  private setTags(hdr: number, size: number, allocated: boolean) {
    const w = size | (allocated ? 1 : 0);
    this.view.setUint32(hdr, w);
    this.view.setUint32(hdr + size - 4, w);
  }

  /** Returns payload address (8-byte aligned) or null when out of memory. */
  malloc(n: number, label = ""): number | null {
    if (!Number.isInteger(n) || n <= 0) throw new Error("malloc size must be a positive integer");
    const need = Math.max(MIN_BLOCK, align8(n + 2 * HDR));
    let chosen = -1;
    let chosenSize = Infinity;
    for (let hdr = 4; ; ) {
      const { size, allocated } = this.word(hdr);
      if (size === 0) break;
      this.stats.scanned++;
      if (!allocated && size >= need) {
        if (this.fit === "first") {
          chosen = hdr;
          chosenSize = size;
          break;
        }
        if (size < chosenSize) {
          chosen = hdr;
          chosenSize = size;
          if (size === need) break;
        }
      }
      hdr += size;
    }
    if (chosen < 0) {
      this.stats.failed++;
      this.emitter?.emit("malloc_failed", "heap", { requested: n, need });
      return null;
    }
    if (chosenSize - need >= MIN_BLOCK) {
      this.setTags(chosen, need, true);
      this.setTags(chosen + need, chosenSize - need, false);
      this.stats.splits++;
    } else {
      this.setTags(chosen, chosenSize, true);
    }
    const payload = chosen + HDR;
    this.live.set(payload, { requested: n, label, at: ++this.clock });
    this.stats.mallocs++;
    this.emitter?.emit("malloc", "heap", { addr: payload, requested: n, block: this.word(chosen).size, fit: this.fit });
    return payload;
  }

  free(payload: number): void {
    if (!this.live.has(payload)) {
      const err = payload >= 0 && payload < this.size ? "double free or invalid pointer" : "pointer outside heap";
      this.emitter?.emit("free_error", "heap", { addr: payload, error: err });
      throw new Error(`${err}: 0x${payload.toString(16)}`);
    }
    this.live.delete(payload);
    let hdr = payload - HDR;
    let { size } = this.word(hdr);
    const next = this.word(hdr + size);
    if (!next.allocated && next.size > 0) {
      size += next.size;
      this.stats.coalesces++;
    }
    const prevFtr = this.word(hdr - 4);
    if (!prevFtr.allocated && prevFtr.size > 0) {
      hdr -= prevFtr.size;
      size += prevFtr.size;
      this.stats.coalesces++;
    }
    this.setTags(hdr, size, false);
    this.stats.frees++;
    this.emitter?.emit("free", "heap", { addr: payload, coalescedBlock: size });
  }

  /** Write a byte pattern into an allocation (bounds-checked against the requested size). */
  fill(payload: number, value: number): void {
    const a = this.live.get(payload);
    if (!a) throw new Error("fill on unallocated pointer");
    this.bytes.fill(value & 0xff, payload, payload + a.requested);
  }

  blocks(): Block[] {
    const out: Block[] = [];
    for (let hdr = 4; ; ) {
      const { size, allocated } = this.word(hdr);
      if (size === 0) break;
      const payload = hdr + HDR;
      const meta = this.live.get(payload);
      out.push({ addr: hdr, size, allocated, payload, requested: meta?.requested, label: meta?.label });
      hdr += size;
    }
    return out;
  }

  metrics() {
    const blocks = this.blocks();
    const free = blocks.filter((b) => !b.allocated);
    const freeBytes = free.reduce((s, b) => s + b.size, 0);
    const largestFree = free.reduce((m, b) => Math.max(m, b.size), 0);
    const allocated = blocks.filter((b) => b.allocated);
    const usedBytes = allocated.reduce((s, b) => s + b.size, 0);
    const requested = allocated.reduce((s, b) => s + (b.requested ?? 0), 0);
    return {
      heapBytes: this.size,
      usedBytes,
      freeBytes,
      largestFree,
      freeBlocks: free.length,
      liveAllocations: allocated.length,
      // external fragmentation: free memory that can't be served as one request
      fragmentation: freeBytes === 0 ? 0 : 1 - largestFree / freeBytes,
      // internal fragmentation: header/footer/padding overhead inside allocated blocks
      internalOverhead: usedBytes === 0 ? 0 : 1 - requested / usedBytes,
      ...this.stats,
    };
  }

  /** Allocations still live — at "program exit" these are leaks. */
  leaks() {
    return [...this.live.entries()].map(([addr, m]) => ({ addr, ...m }));
  }
}

/** Bump-pointer arena: O(1) alloc with alignment, free everything at once. */
export class Arena {
  readonly size: number;
  offset = 0;
  allocations = 0;
  paddingBytes = 0;

  constructor(size = 16 * 1024) {
    this.size = size;
  }

  alloc(n: number, align = 8): number | null {
    if ((align & (align - 1)) !== 0) throw new Error("alignment must be a power of two");
    const start = (this.offset + align - 1) & ~(align - 1);
    if (start + n > this.size) return null;
    this.paddingBytes += start - this.offset;
    this.offset = start + n;
    this.allocations++;
    return start;
  }

  reset(): void {
    this.offset = 0;
    this.allocations = 0;
    this.paddingBytes = 0;
  }
}

/** Fixed-size pool with an intrusive free list stored inside the free slots themselves. */
export class Pool {
  readonly slotSize: number;
  readonly slots: number;
  readonly view: DataView;
  head: number;
  inUse = 0;
  private live = new Set<number>();

  constructor(slotSize = 32, slots = 64) {
    if (slotSize < 4) throw new Error("slot must hold a 4-byte next pointer");
    this.slotSize = slotSize;
    this.slots = slots;
    this.view = new DataView(new ArrayBuffer(slotSize * slots));
    for (let i = 0; i < slots; i++) this.view.setInt32(i * slotSize, i + 1 < slots ? (i + 1) * slotSize : -1);
    this.head = 0;
  }

  alloc(): number | null {
    if (this.head < 0) return null;
    const addr = this.head;
    this.head = this.view.getInt32(addr);
    this.inUse++;
    this.live.add(addr);
    return addr;
  }

  liveSlots(): number[] {
    return [...this.live];
  }

  free(addr: number): void {
    if (!this.live.delete(addr)) throw new Error("pool double free or foreign pointer");
    this.view.setInt32(addr, this.head);
    this.head = addr;
    this.inUse--;
  }
}

/** Slab allocator: size classes, each backed by pages of equal-sized slots tracked by a bitmap. */
export class Slab {
  static readonly CLASSES = [16, 32, 64, 128];
  readonly pageSize: number;
  pages = new Map<number, { used: Uint8Array }[]>();

  constructor(pageSize = 1024) {
    this.pageSize = pageSize;
    for (const c of Slab.CLASSES) this.pages.set(c, []);
  }

  classFor(n: number): number | null {
    return Slab.CLASSES.find((c) => c >= n) ?? null;
  }

  alloc(n: number): { cls: number; page: number; slot: number } | null {
    const cls = this.classFor(n);
    if (cls === null) return null;
    const pages = this.pages.get(cls)!;
    for (let p = 0; p < pages.length; p++) {
      const slot = pages[p].used.indexOf(0);
      if (slot >= 0) {
        pages[p].used[slot] = 1;
        return { cls, page: p, slot };
      }
    }
    pages.push({ used: new Uint8Array(this.pageSize / cls) });
    pages[pages.length - 1].used[0] = 1;
    return { cls, page: pages.length - 1, slot: 0 };
  }

  free(h: { cls: number; page: number; slot: number }): void {
    const page = this.pages.get(h.cls)?.[h.page];
    if (!page || page.used[h.slot] !== 1) throw new Error("slab double free");
    page.used[h.slot] = 0;
  }

  utilization() {
    return Slab.CLASSES.map((cls) => {
      const pages = this.pages.get(cls)!;
      const total = pages.reduce((s, p) => s + p.used.length, 0);
      const used = pages.reduce((s, p) => s + p.used.reduce((a, b) => a + b, 0), 0);
      return { cls, pages: pages.length, used, total };
    });
  }
}

export type TraceOp = { op: "malloc"; id: number; size: number } | { op: "free"; id: number };

/** Deterministic random workload: mixed sizes, ~45% frees. */
export function makeTrace(ops: number, seed = 7, maxSize = 512): TraceOp[] {
  const r = rng(seed);
  const trace: TraceOp[] = [];
  const live: number[] = [];
  let id = 0;
  for (let i = 0; i < ops; i++) {
    if (live.length > 0 && r() < 0.45) {
      const k = Math.floor(r() * live.length);
      trace.push({ op: "free", id: live[k] });
      live.splice(k, 1);
    } else {
      const size = r() < 0.7 ? 8 + Math.floor(r() * 64) : 64 + Math.floor(r() * (maxSize - 64));
      trace.push({ op: "malloc", id: id, size });
      live.push(id++);
    }
  }
  return trace;
}

/** Replay one trace against a fit strategy; numbers are measured, not estimated. */
export function runTrace(trace: TraceOp[], fit: Fit, heapSize = 64 * 1024) {
  const heap = new FreeListHeap(heapSize, fit);
  const ptr = new Map<number, number>();
  const t0 = now();
  for (const t of trace) {
    if (t.op === "malloc") {
      const p = heap.malloc(t.size);
      if (p !== null) ptr.set(t.id, p);
    } else {
      const p = ptr.get(t.id);
      if (p !== undefined) {
        heap.free(p);
        ptr.delete(t.id);
      }
    }
  }
  const ms = now() - t0;
  const m = heap.metrics();
  return { fit, ms, ...m };
}

/** Same trace through JS's own allocator (typed arrays), for a rough baseline. */
export function runNativeBaseline(trace: TraceOp[]) {
  const live = new Map<number, Uint8Array>();
  const t0 = now();
  for (const t of trace) {
    if (t.op === "malloc") live.set(t.id, new Uint8Array(t.size));
    else live.delete(t.id);
  }
  return { ms: now() - t0, live: live.size };
}
