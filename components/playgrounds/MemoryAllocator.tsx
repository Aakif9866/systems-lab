"use client";
import { useState } from "react";
import { Arena, FreeListHeap, Pool, Slab, makeTrace, runNativeBaseline, runTrace, type Fit } from "@/lib/systems/memory-allocator/engine";
import { Emitter } from "@/lib/systems/shared";
import { Btn, Controls, EventLog, NumField, Panel, Select, Stats, fmt, pct, useEngine } from "../lab/kit";

const HEAP = 16 * 1024; // small enough that every block is visible
const hex = (n: number, w = 4) => "0x" + n.toString(16).padStart(w, "0");

export default function MemoryAllocator() {
  const [lab, force, replace] = useEngine(() => {
    const emitter = new Emitter("memory-allocator");
    return { emitter, heap: new FreeListHeap(HEAP, "first", emitter), arena: new Arena(1024), pool: new Pool(32, 16), slab: new Slab(256) };
  });
  const { emitter, arena, pool, slab } = lab;
  const [fit, setFit] = useState<Fit>("first");
  const [size, setSize] = useState(200);
  const [sel, setSel] = useState<number | null>(null);
  const [msg, setMsg] = useState("");
  const [align, setAlign] = useState(8);
  const [arenaLog, setArenaLog] = useState<string[]>([]);
  const [cmp, setCmp] = useState<null | { rows: ReturnType<typeof runTrace>[]; native: ReturnType<typeof runNativeBaseline>; ops: number }>(null);

  const h = lab.heap;
  const m = h.metrics();
  const blocks = h.blocks();
  const selBlock = blocks.find((b) => b.payload === sel);

  const malloc = (n: number, label = "") => {
    const p = h.malloc(n, label);
    setMsg(p === null ? `malloc(${n}) → NULL (out of memory${m.freeBytes >= n ? ` — ${fmt(m.freeBytes)} B free but fragmented` : ""})` : `malloc(${n}) → ${hex(p)}`);
    if (p !== null) setSel(p);
    force();
    return p;
  };
  const free = (p: number) => {
    try { h.free(p); setMsg(`free(${hex(p)})`); } catch (e) { setMsg((e as Error).message); }
    if (sel === p) setSel(null);
    force();
  };

  const fragment = () => {
    h.reset();
    const ps: number[] = [];
    // fill the whole heap with 200–320 B blocks, then free every other one
    for (let i = 0; ; i++) { const p = h.malloc(200 + ((i * 37) % 120)); if (p === null) break; ps.push(p); }
    ps.forEach((p, i) => { if (i % 2 === 0) h.free(p); });
    setSel(null);
    const mm = h.metrics();
    setMsg(`filled the heap with ${ps.length} blocks, freed every other one: ${fmt(mm.freeBytes)} B free, but the largest hole is ${mm.largestFree} B → try malloc(2000)`);
    force();
  };

  const dumpStart = selBlock ? selBlock.addr : 0;
  const dump = Array.from(h.bytes.slice(dumpStart, dumpStart + 64));

  return (
    <div className="space-y-8">
      <Controls>
        <Select label="fit" value={fit} options={["first", "best"] as const} onChange={(f) => { setFit(f); h.setFit(f); }} />
        <NumField label="bytes" value={size} min={1} max={HEAP} onChange={setSize} />
        <Btn tone="hue" onClick={() => malloc(size)}>malloc({size})</Btn>
        <Btn onClick={() => sel !== null && free(sel)} disabled={sel === null}>free selected</Btn>
        <Btn onClick={() => { if (sel === null) return; const p = sel; h.free(p); try { h.free(p); } catch (e) { setMsg(`free(${hex(p)}) twice → caught: ${(e as Error).message}`); } setSel(null); force(); }} disabled={sel === null} tone="danger" title="frees the pointer twice">double free</Btn>
        <Btn onClick={() => { if (sel !== null) { h.fill(sel, 0xab); setMsg(`wrote 0xAB × ${h.live.get(sel)?.requested} at ${hex(sel)}`); force(); } }} disabled={sel === null}>fill 0xAB</Btn>
        <Btn onClick={() => { for (let i = 0; i < 12; i++) h.malloc(16 + Math.floor(Math.random() * 400)); force(); }}>random ×12</Btn>
        <Btn onClick={fragment}>fragment it</Btn>
        <Btn onClick={() => { for (const p of [...h.live.keys()]) h.free(p); setSel(null); setMsg("freed everything — watch it coalesce to one block"); force(); }}>free all</Btn>
        <Btn onClick={() => { replace(); setFit("first"); setSel(null); setMsg(""); }}>reset</Btn>
      </Controls>
      {msg && <p className="text-sm text-hue">› {msg}</p>}

      <Panel title={`heap · ${fmt(HEAP)} bytes · each segment is a real block (header | payload | footer) — click one`}>
        <div className="flex h-14 w-full overflow-hidden rounded-sm bg-surface" role="list">
          {blocks.map((b) => (
            <button
              type="button"
              role="listitem"
              key={b.addr}
              title={`${hex(b.addr)} · ${b.size} B · ${b.allocated ? `allocated (${b.requested} requested)` : "free"}`}
              onClick={() => b.allocated && setSel(b.payload)}
              className="h-full shrink-0 border-r border-[var(--bg)] transition-[width] duration-300"
              style={{
                width: `${(b.size / HEAP) * 100}%`,
                background: b.allocated ? (b.payload === sel ? "var(--heading)" : "var(--hue)") : "var(--surface-2)",
                opacity: b.allocated ? 0.55 + 0.45 * Math.min(1, (b.requested ?? 0) / b.size) : 1,
              }}
            />
          ))}
        </div>
        <div className="mt-1 flex justify-between text-xs text-muted tabular-nums"><span>0x0000</span><span>{hex(HEAP)}</span></div>
      </Panel>

      <Stats items={[
        ["used / free", `${fmt(m.usedBytes)} / ${fmt(m.freeBytes)} B`], ["largest free block", `${fmt(m.largestFree)} B`], ["external fragmentation", pct(m.fragmentation)], ["internal overhead", pct(m.internalOverhead)],
        ["live allocations", m.liveAllocations], ["free blocks", m.freeBlocks], ["splits / coalesces", `${m.splits} / ${m.coalesces}`], ["failed mallocs", m.failed],
      ]} />

      <div className="grid grid-cols-1 gap-8 lg:grid-cols-2">
        <Panel title={selBlock ? `block ${hex(selBlock.addr)} — raw bytes from the ArrayBuffer` : "select an allocated block"}>
          {selBlock ? (
            <>
              <p className="text-sm">header {hex(h.view.getUint32(selBlock.addr), 8)} = size {selBlock.size} | allocated bit · payload at {hex(selBlock.payload)} (aligned to {selBlock.payload % 16 === 0 ? 16 : 8}) · requested {selBlock.requested} B</p>
              <pre className="mt-3 text-xs bg-surface p-3 rounded-sm overflow-x-auto tabular-nums">
                {Array.from({ length: 4 }, (_, r) => `${hex(dumpStart + r * 16)}  ${dump.slice(r * 16, r * 16 + 16).map((b) => b.toString(16).padStart(2, "0")).join(" ")}`).join("\n")}
              </pre>
              <p className="mt-2 text-xs text-muted">First 4 bytes = header word. Bytes after the requested size are padding; the last 4 bytes of the block are the footer.</p>
            </>
          ) : <p className="text-sm text-muted">Allocate something, then click its segment in the heap map.</p>}
        </Panel>
        <Panel title="leak report (live allocations at 'exit')">
          <div className="max-h-48 overflow-auto text-xs bg-surface p-3 rounded-sm">
            {h.leaks().length === 0 ? <p className="text-muted">no leaks</p> : h.leaks().map((l) => <div key={l.addr}>{hex(l.addr)} · {l.requested} B · alloc #{l.at}</div>)}
          </div>
        </Panel>
      </div>

      <Panel title="strategy comparison — same deterministic trace, measured now">
        <Controls>
          {[2000, 10000].map((ops) => (
            <Btn key={ops} onClick={() => { const t = makeTrace(ops, 7); setCmp({ rows: [runTrace(t, "first"), runTrace(t, "best")], native: runNativeBaseline(t), ops }); }}>run {fmt(ops)} ops</Btn>
          ))}
        </Controls>
        {cmp && (
          <div className="mt-4 overflow-x-auto">
            <table className="text-sm tabular-nums w-full min-w-[34rem]">
              <thead className="text-muted text-xs text-left"><tr><th className="font-normal py-1">allocator</th><th className="font-normal">time</th><th className="font-normal">blocks scanned</th><th className="font-normal">failed</th><th className="font-normal">fragmentation</th><th className="font-normal">overhead</th></tr></thead>
              <tbody>
                {cmp.rows.map((r) => <tr key={r.fit}><td className="py-1 text-heading">{r.fit}-fit</td><td>{fmt(r.ms, 2)} ms</td><td>{fmt(r.scanned)}</td><td>{r.failed}</td><td>{pct(r.fragmentation)}</td><td>{pct(r.internalOverhead)}</td></tr>)}
                <tr><td className="py-1 text-muted">JS engine (typed arrays)</td><td>{fmt(cmp.native.ms, 2)} ms</td><td className="text-muted" colSpan={4}>baseline: the browser&apos;s own allocator + GC</td></tr>
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <div className="grid grid-cols-1 gap-8 lg:grid-cols-3">
        <Panel title={`arena · bump pointer · ${arena.offset}/${arena.size} B`}>
          <Controls>
            <Select label="align" value={String(align) as "8"} options={["1", "8", "16", "64"] as const} onChange={(v) => setAlign(Number(v))} />
            <Btn onClick={() => { const n = 5 + Math.floor(Math.random() * 40); const p = arena.alloc(n, align); setArenaLog((l) => [...l.slice(-5), p === null ? `alloc(${n}) → full` : `alloc(${n}, align ${align}) → ${p}`]); }}>alloc</Btn>
            <Btn onClick={() => { arena.reset(); setArenaLog(["reset: everything freed in O(1)"]); }}>reset</Btn>
          </Controls>
          <p className="mt-2 text-xs text-muted">padding wasted: {arena.paddingBytes} B</p>
          <div className="mt-2 text-xs space-y-0.5">{arenaLog.map((l, i) => <div key={i}>{l}</div>)}</div>
        </Panel>
        <Panel title={`pool · 16 × 32 B slots · ${pool.inUse} in use`}>
          <Controls>
            <Btn onClick={() => { const p = pool.alloc(); setMsg(p === null ? "pool exhausted" : `pool slot ${p}`); force(); }}>alloc</Btn>
            <Btn onClick={() => { const live = pool.liveSlots(); if (live.length) pool.free(live[live.length - 1]); force(); }}>free last</Btn>
          </Controls>
          <div className="mt-3 grid grid-cols-8 gap-1">{Array.from({ length: 16 }, (_, i) => <div key={i} className="h-4 rounded-sm" style={{ background: pool.liveSlots().includes(i * 32) ? "var(--hue)" : "var(--surface-2)" }} />)}</div>
          <p className="mt-2 text-xs text-muted">free-list head → slot {pool.head < 0 ? "none" : pool.head / 32}</p>
        </Panel>
        <Panel title="slab · size classes 16/32/64/128">
          <Btn onClick={() => { slab.alloc(1 + Math.floor(Math.random() * 128)); force(); }}>alloc random size</Btn>
          <div className="mt-3 text-xs space-y-1 tabular-nums">
            {slab.utilization().map((u) => <div key={u.cls}><span className="text-muted w-14 inline-block">{u.cls} B</span> {u.used}/{u.total} slots · {u.pages} page(s)</div>)}
          </div>
        </Panel>
      </div>

      <Panel title="allocator events">
        <EventLog events={emitter.events} height="h-40" />
      </Panel>
    </div>
  );
}
