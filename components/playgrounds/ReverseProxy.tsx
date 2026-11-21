"use client";
import { useRef, useState } from "react";
import { Proxy, type Strategy } from "@/lib/systems/reverse-proxy/engine";
import { Btn, Controls, EventLog, NumField, Panel, Select, Stats, fmt, pct, useEngine, useTicker } from "../lab/kit";

const STRATS = ["round-robin", "least-connections", "consistent-hash"] as const;

function Spark({ data, label, unit }: { data: number[]; label: string; unit: string }) {
  const w = 260, h = 48, max = Math.max(1, ...data);
  const pts = data.map((v, i) => `${(i / Math.max(1, data.length - 1)) * w},${h - (v / max) * (h - 4) - 2}`).join(" ");
  return (
    <div className="min-w-0">
      <p className="text-xs text-muted">{label} <span className="text-heading tabular-nums">{fmt(data[data.length - 1] ?? 0)}{unit}</span> <span className="text-dim">max {fmt(max)}</span></p>
      <svg viewBox={`0 0 ${w} ${h}`} className="w-full h-12" aria-hidden="true"><polyline points={pts} fill="none" stroke="var(--hue)" strokeWidth="1.5" /></svg>
    </div>
  );
}

export default function ReverseProxy() {
  const build = () => {
    const p = new Proxy({ rps: 150 });
    p.addBackend("api-1", 30);
    p.addBackend("api-2", 40);
    p.addBackend("api-3", 50);
    return p;
  };
  const [p, force, replace] = useEngine(build);
  const [hist, setHist] = useState<{ t: number[]; p99: number[]; err: number[] }>({ t: [], p99: [], err: [] });
  const nextId = useRef(4);
  const [running, setRunning] = useState(true);

  useTicker(() => {
    p.run(100);
    const m = p.metrics();
    const keep = (a: number[], v: number) => [...a.slice(-79), v];
    setHist((h) => ({ t: keep(h.t, m.throughput), p99: keep(h.p99, m.p99), err: keep(h.err, Math.round(m.errorRate * 100)) }));
  }, running, 100);

  const m = p.metrics();
  const total = m.backends.reduce((s, b) => s + b.served, 0) || 1;
  const set = (patch: Parameters<Proxy["setConfig"]>[0]) => { p.setConfig(patch); force(); };

  return (
    <div className="space-y-8">
      <Controls>
        <Btn tone="hue" onClick={() => setRunning((r) => !r)}>{running ? "⏸ pause" : "▶ run"}</Btn>
        <Select label="strategy" value={p.cfg.strategy} options={STRATS} onChange={(s: Strategy) => set({ strategy: s })} />
        <NumField label="req/s" value={p.cfg.rps} min={0} max={3000} step={50} onChange={(v) => set({ rps: v })} />
        <NumField label="retries" value={p.cfg.retries} min={0} max={3} onChange={(v) => set({ retries: v })} />
        <NumField label="timeout ms" value={p.cfg.timeoutMs} min={50} max={5000} step={50} onChange={(v) => set({ timeoutMs: v })} />
      </Controls>
      <Controls>
        <NumField label="breaker after N fails" value={p.cfg.breakerThreshold} min={1} max={50} onChange={(v) => set({ breakerThreshold: v })} />
        <NumField label="rate limit /s" value={p.cfg.rateRefillPerSec} min={1} max={5000} step={50} onChange={(v) => set({ rateRefillPerSec: v })} />
        <NumField label="burst" value={p.cfg.rateCapacity} min={1} max={5000} step={10} onChange={(v) => set({ rateCapacity: v })} />
        <Btn onClick={() => { p.addBackend(`api-${nextId.current++}`, 40); force(); }}>+ backend</Btn>
        <Btn onClick={() => { replace(); setHist({ t: [], p99: [], err: [] }); nextId.current = 4; }}>reset</Btn>
      </Controls>

      <Panel title="backends — change their behaviour live">
        <div className="overflow-x-auto">
          <table className="text-sm tabular-nums w-full min-w-[46rem]">
            <thead className="text-xs text-muted text-left">
              <tr>{["backend", "latency ms", "error %", "process", "health", "breaker", "share", "served / errors", "active", "pool reuse", ""].map((h) => <th key={h} className="font-normal py-1 pr-3">{h}</th>)}</tr>
            </thead>
            <tbody>
              {m.backends.map((b) => {
                const raw = p.backends.get(b.id)!;
                return (
                  <tr key={b.id} className="border-t border-border">
                    <td className="py-2 pr-3 text-heading">{b.id}</td>
                    <td className="pr-3"><input aria-label={`${b.id} latency`} type="number" min={1} max={2000} value={raw.latency} onChange={(e) => { p.updateBackend(b.id, { latency: Math.max(1, Number(e.target.value) || 1) }); force(); }} className="w-16 bg-surface px-1 py-1 rounded-sm" /></td>
                    <td className="pr-3"><input aria-label={`${b.id} error rate`} type="number" min={0} max={100} value={Math.round(raw.errorRate * 100)} onChange={(e) => { p.updateBackend(b.id, { errorRate: Math.min(1, Math.max(0, Number(e.target.value) / 100)) }); force(); }} className="w-14 bg-surface px-1 py-1 rounded-sm" /></td>
                    <td className="pr-3"><button type="button" onClick={() => { p.updateBackend(b.id, { up: !raw.up }); force(); }} className={`text-xs px-2 py-1 rounded-sm bg-surface ${raw.up ? "text-heading" : "text-error"}`}>{raw.up ? "up · kill" : "down · revive"}</button></td>
                    <td className={`pr-3 ${b.healthy ? "text-hue" : "text-error"}`}>{b.healthy ? "healthy" : "ejected"}</td>
                    <td className={`pr-3 ${b.breaker === "closed" ? "text-muted" : b.breaker === "open" ? "text-error" : "text-heading"}`}>{b.breaker}</td>
                    <td className="pr-3 w-28"><div className="h-2 bg-surface rounded-sm"><div className="h-2 rounded-sm" style={{ width: `${(b.served / total) * 100}%`, background: "var(--hue)" }} /></div></td>
                    <td className="pr-3">{fmt(b.served)} / {fmt(b.errors)}</td>
                    <td className="pr-3">{b.active}</td>
                    <td className="pr-3">{pct(b.poolReuse)}</td>
                    <td><button type="button" onClick={() => { p.removeBackend(b.id); force(); }} className="text-xs text-muted hover:text-error">remove</button></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Panel>

      <div className="grid grid-cols-1 gap-6 sm:grid-cols-3">
        <Spark data={hist.t} label="throughput" unit=" req/s" />
        <Spark data={hist.p99} label="p99" unit=" ms" />
        <Spark data={hist.err} label="error rate" unit="%" />
      </div>

      <Stats items={[
        ["virtual time", `${fmt(m.time / 1000, 1)} s`], ["throughput (last 1s)", `${fmt(m.throughput)} req/s`], ["p50 / p95 / p99", `${fmt(m.p50)} / ${fmt(m.p95)} / ${fmt(m.p99)} ms`], ["error rate", pct(m.errorRate)],
        ["429 rate-limited", fmt(m.rateLimited)], ["503 no backend", fmt(m.noBackend)], ["retries", fmt(m.retries)], ["timeouts", fmt(m.timeouts)],
      ]} />

      <Panel title="proxy events — breakers, health checks, retries">
        <EventLog events={p.emitter.events} height="h-40" />
      </Panel>
    </div>
  );
}
