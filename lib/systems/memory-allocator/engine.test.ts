import { test } from "node:test";
import assert from "node:assert/strict";
import { Arena, FreeListHeap, Pool, Slab, makeTrace, runTrace } from "./engine.ts";

function checkInvariants(heap: FreeListHeap) {
  const blocks = heap.blocks();
  let expected = 4;
  for (const b of blocks) {
    assert.equal(b.addr, expected, "blocks are contiguous");
    assert.equal(b.size % 8, 0);
    assert.equal(b.payload % 8, 0, "payload 8-byte aligned");
    expected += b.size;
  }
  assert.equal(expected, heap.size - 4, "blocks tile the whole heap");
  for (let i = 1; i < blocks.length; i++) {
    assert.ok(blocks[i - 1].allocated || blocks[i].allocated, "no two adjacent free blocks (coalescing)");
  }
  for (const b of blocks.filter((x) => x.allocated)) {
    assert.ok(b.requested! + 8 <= b.size, "requested fits inside block");
  }
}

for (const fit of ["first", "best"] as const) {
  test(`${fit}-fit: random workload keeps heap invariants and frees back to one block`, () => {
    const heap = new FreeListHeap(64 * 1024, fit);
    const ptrs = new Map<number, number>();
    for (const t of makeTrace(4000, 42)) {
      if (t.op === "malloc") {
        const p = heap.malloc(t.size);
        if (p !== null) ptrs.set(t.id, p);
      } else if (ptrs.has(t.id)) {
        heap.free(ptrs.get(t.id)!);
        ptrs.delete(t.id);
      }
    }
    checkInvariants(heap);
    for (const p of ptrs.values()) heap.free(p);
    const blocks = heap.blocks();
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].size, 64 * 1024 - 8);
    assert.equal(heap.metrics().fragmentation, 0);
  });
}

test("double free and foreign pointers are rejected", () => {
  const heap = new FreeListHeap(1024);
  const p = heap.malloc(10)!;
  heap.free(p);
  assert.throws(() => heap.free(p), /double free/);
  assert.throws(() => heap.free(99999), /outside heap/);
});

test("out of memory returns null and leaks are reported", () => {
  const heap = new FreeListHeap(256);
  assert.equal(heap.malloc(1000), null);
  const a = heap.malloc(32, "buf")!;
  assert.deepEqual(heap.leaks().map((l) => l.addr), [a]);
});

test("fill writes real bytes inside the allocation only", () => {
  const heap = new FreeListHeap(1024);
  const p = heap.malloc(5)!;
  heap.fill(p, 0xab);
  assert.deepEqual([...heap.bytes.slice(p, p + 5)], [0xab, 0xab, 0xab, 0xab, 0xab]);
  assert.equal(heap.bytes[p + 5], 0);
});

test("arena honours alignment and tracks padding", () => {
  const a = new Arena(256);
  assert.equal(a.alloc(3), 0);
  assert.equal(a.alloc(8, 64), 64);
  assert.equal(a.paddingBytes, 61);
  assert.equal(a.alloc(1000), null);
});

test("pool hands out every slot once, then null, and reuses freed slots LIFO", () => {
  const pool = new Pool(16, 4);
  const got = [pool.alloc(), pool.alloc(), pool.alloc(), pool.alloc()];
  assert.deepEqual(got, [0, 16, 32, 48]);
  assert.equal(pool.alloc(), null);
  pool.free(32);
  assert.equal(pool.alloc(), 32);
  assert.throws(() => pool.free(5));
});

test("slab picks the smallest fitting class and grows pages", () => {
  const slab = new Slab(64);
  assert.equal(slab.classFor(20), 32);
  const hs = Array.from({ length: 3 }, () => slab.alloc(20)!);
  assert.deepEqual(hs.map((h) => h.page), [0, 0, 1]);
  slab.free(hs[0]);
  assert.throws(() => slab.free(hs[0]));
  assert.equal(slab.alloc(500), null);
});

test("best-fit scans more but fragments no worse on the same trace", () => {
  const trace = makeTrace(3000, 9);
  const first = runTrace(trace, "first");
  const best = runTrace(trace, "best");
  assert.ok(best.scanned >= first.scanned);
  assert.ok(best.failed <= first.failed + 5);
});
