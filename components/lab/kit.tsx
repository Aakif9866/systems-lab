"use client";
import { useEffect, useReducer, useRef, useState, type ReactNode } from "react";
import type { LabEvent } from "@/lib/systems/shared";

export function useForce() {
  const [, f] = useReducer((x: number) => x + 1, 0);
  return f;
}

/**
 * Holds a mutable engine instance. Engines mutate themselves; `refresh()` re-renders after a mutation,
 * `replace()` swaps in a fresh instance (reset / new config).
 */
export function useEngine<T>(make: () => T): [T, () => void, (next?: T) => void] {
  const [box, setBox] = useState(() => ({ v: make() }));
  const refresh = useForce();
  return [box.v, refresh, (next?: T) => setBox({ v: next ?? make() })];
}

/** setInterval that respects the latest callback and pauses when `on` is false. */
export function useTicker(fn: () => void, on: boolean, ms: number) {
  const ref = useRef(fn);
  useEffect(() => { ref.current = fn; });
  useEffect(() => {
    if (!on) return;
    const id = setInterval(() => ref.current(), ms);
    return () => clearInterval(id);
  }, [on, ms]);
}

export function Btn({ children, onClick, tone = "default", disabled, title, submit }: { children: ReactNode; onClick?: () => void; tone?: "default" | "hue" | "danger"; disabled?: boolean; title?: string; submit?: boolean }) {
  const c = tone === "hue" ? "text-hue" : tone === "danger" ? "text-error" : "text-heading";
  return (
    <button type={submit ? "submit" : "button"} title={title} disabled={disabled} onClick={onClick} className={`bg-surface hover:bg-surface-2 ${c} px-3 py-2 min-h-[36px] rounded-sm text-sm active:scale-95 transition disabled:opacity-40 disabled:pointer-events-none`}>
      {children}
    </button>
  );
}

export function NumField({ label, value, onChange, min, max, step = 1 }: { label: string; value: number; onChange: (v: number) => void; min: number; max: number; step?: number }) {
  return (
    <label className="flex items-center gap-2 text-sm">
      <span className="text-muted">{label}</span>
      <input type="number" value={value} min={min} max={max} step={step} onChange={(e) => { const v = Number(e.target.value); if (Number.isFinite(v)) onChange(Math.min(max, Math.max(min, v))); }} className="w-20 bg-surface text-heading px-2 py-1.5 rounded-sm" />
    </label>
  );
}

export function Select<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: readonly T[]; onChange: (v: T) => void }) {
  return (
    <label className="flex items-center gap-2 text-sm">
      <span className="text-muted">{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value as T)} className="bg-surface text-heading px-2 py-1.5 rounded-sm">
        {options.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    </label>
  );
}

export function Toggle({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center gap-2 text-sm cursor-pointer">
      <input type="checkbox" checked={value} onChange={(e) => onChange(e.target.checked)} className="accent-[var(--hue)] w-4 h-4" />
      <span className="text-muted">{label}</span>
    </label>
  );
}

export function Controls({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-center gap-x-4 gap-y-3">{children}</div>;
}

export function Stats({ items }: { items: [string, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-x-6 gap-y-4">
      {items.map(([k, v]) => (
        <div key={k} className="min-w-0">
          <dd className="text-xl text-heading tabular-nums truncate">{v}</dd>
          <dt className="text-xs text-muted">{k}</dt>
        </div>
      ))}
    </dl>
  );
}

export function Panel({ title, children, className = "" }: { title: string; children: ReactNode; className?: string }) {
  return (
    <div className={`min-w-0 ${className}`}>
      <p className="text-xs text-muted mb-2">{title}</p>
      {children}
    </div>
  );
}

export function EventLog({ events, height = "h-56" }: { events: LabEvent[]; height?: string }) {
  const [q, setQ] = useState("");
  const types = [...new Set(events.map((e) => e.event_type))].sort();
  const shown = (q ? events.filter((e) => e.event_type.includes(q) || e.source.includes(q)) : events).slice(-80).reverse();
  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 mb-2">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="filter by event type or source" aria-label="filter events" className="bg-surface text-heading text-xs px-2 py-1.5 rounded-sm w-56" />
        {types.slice(0, 10).map((t) => (
          <button key={t} type="button" onClick={() => setQ(q === t ? "" : t)} className={`text-[11px] px-1.5 py-0.5 rounded-sm ${q === t ? "bg-surface-2 text-hue" : "text-muted hover:text-heading"}`}>{t}</button>
        ))}
      </div>
      <div className={`${height} overflow-auto bg-surface rounded-sm p-3 text-xs leading-relaxed`} aria-live="off">
        {shown.length === 0 && <p className="text-muted">{events.length ? "no matching events" : "no events yet — run something"}</p>}
        {shown.map((e) => (
          <div key={e.execution_id + e.seq} className="flex gap-2 whitespace-nowrap">
            <span className="text-muted tabular-nums">#{e.seq}</span>
            <span className="text-hue">{e.event_type}</span>
            <span className="text-heading">{e.source}</span>
            <span className="text-muted truncate">{JSON.stringify(e.payload)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function Honesty({ real, simulated }: { real: string[]; simulated: string[] }) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 text-sm">
      <div>
        <p className="text-hue text-xs mb-1">real — runs in this tab</p>
        <ul className="space-y-1">{real.map((r) => <li key={r}>✓ {r}</li>)}</ul>
      </div>
      <div>
        <p className="text-muted text-xs mb-1">simulated / modelled</p>
        <ul className="space-y-1 text-muted">{simulated.map((r) => <li key={r}>~ {r}</li>)}</ul>
      </div>
    </div>
  );
}

/** A terminal: input with history (↑/↓), scrollback, and an exec callback that may throw. */
export function Terminal({ prompt, exec, hint, initial = [] }: { prompt: string; exec: (line: string) => string; hint?: string; initial?: string[] }) {
  const [lines, setLines] = useState<{ kind: "in" | "out" | "err"; text: string }[]>(initial.map((t) => ({ kind: "out", text: t })));
  const [value, setValue] = useState("");
  const hist = useRef<string[]>([]);
  const hi = useRef(-1);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { end.current?.scrollIntoView({ block: "nearest" }); }, [lines]);
  const run = (line: string) => {
    if (!line.trim()) return;
    hist.current.unshift(line);
    hi.current = -1;
    if (line.trim() === "clear") return setLines([]);
    let out: { kind: "out" | "err"; text: string };
    try { out = { kind: "out", text: exec(line) }; } catch (e) { out = { kind: "err", text: (e as Error).message }; }
    setLines((l) => [...l.slice(-300), { kind: "in", text: line }, ...(out.text ? [out] : [])]);
  };
  return (
    <div className="bg-surface rounded-sm">
      <div className="h-72 overflow-auto p-3 text-sm">
        {lines.map((l, i) => (
          <pre key={i} className={`whitespace-pre-wrap [overflow-wrap:anywhere] ${l.kind === "in" ? "text-heading" : l.kind === "err" ? "text-error" : "text-text"}`}>
            {l.kind === "in" ? <><span className="text-hue">{prompt}</span> {l.text}</> : l.text}
          </pre>
        ))}
        <div ref={end} />
      </div>
      <form onSubmit={(e) => { e.preventDefault(); run(value); setValue(""); }} className="flex items-center gap-2 border-t border-border px-3 py-2">
        <span className="text-hue text-sm shrink-0">{prompt}</span>
        <input
          aria-label="command"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowUp" && hist.current.length) { e.preventDefault(); hi.current = Math.min(hist.current.length - 1, hi.current + 1); setValue(hist.current[hi.current]); }
            if (e.key === "ArrowDown") { e.preventDefault(); hi.current = Math.max(-1, hi.current - 1); setValue(hi.current < 0 ? "" : hist.current[hi.current]); }
          }}
          spellCheck={false}
          autoComplete="off"
          className="flex-1 min-w-0 bg-transparent text-heading text-sm outline-none caret-[var(--accent)]"
          placeholder={hint}
        />
      </form>
    </div>
  );
}

export const fmt = (n: number, d = 0) => (Number.isFinite(n) ? n.toLocaleString(undefined, { maximumFractionDigits: d, minimumFractionDigits: d }) : "—");
export const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
