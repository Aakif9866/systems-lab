"use client";
import { useEffect, useState } from "react";
import type { DEdge, DNode } from "@/lib/projects";

const W = 150, H = 42, CW = 196, RH = 92, PAD = 16;

/** Point where the segment from a box centre towards (dx,dy) leaves the box. */
function exit(cx: number, cy: number, dx: number, dy: number) {
  const sx = dx === 0 ? Infinity : W / 2 / Math.abs(dx);
  const sy = dy === 0 ? Infinity : H / 2 / Math.abs(dy);
  const s = Math.min(sx, sy);
  return [cx + dx * s, cy + dy * s];
}

export function Diagram({ nodes, edges, title }: { nodes: DNode[]; edges: DEdge[]; title: string }) {
  const [sel, setSel] = useState<string | null>(null);
  const [trace, setTrace] = useState(-1);
  const cols = Math.max(...nodes.map((n) => n.col)) + 1;
  const rows = Math.max(...nodes.map((n) => n.row)) + 1;
  const vw = (cols - 1) * CW + W + PAD * 2;
  const vh = (rows - 1) * RH + H + PAD * 2;
  const pos = new Map(nodes.map((n) => [n.id, { x: PAD + n.col * CW, y: PAD + n.row * RH }]));
  const selected = nodes.find((n) => n.id === sel);

  useEffect(() => {
    if (trace < 0) return;
    if (trace >= edges.length) {
      const t = setTimeout(() => setTrace(-1), 900);
      return () => clearTimeout(t);
    }
    const t = setTimeout(() => setTrace((x) => x + 1), 650);
    return () => clearTimeout(t);
  }, [trace, edges.length]);

  const active = (e: DEdge, i: number) => (trace >= 0 ? i <= trace : sel ? e.from === sel || e.to === sel : false);

  return (
    <div>
      <div className="flex flex-wrap items-center gap-3 mb-3 text-sm">
        <button type="button" onClick={() => { setSel(null); setTrace(0); }} className="bg-surface hover:bg-surface-2 text-heading px-3 py-2 rounded-sm active:scale-95 transition">
          ▶ follow a request
        </button>
        <span className="text-muted">click a component to inspect it and highlight its paths</span>
      </div>
      <div className="bg-surface/40 rounded-md">
        <svg viewBox={`0 0 ${vw} ${vh}`} role="img" aria-label={title} className="w-full h-auto block">
          <defs>
            <marker id="arr" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0,0 L8,4 L0,8 z" fill="var(--dim)" />
            </marker>
            <marker id="arr-on" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0,0 L8,4 L0,8 z" fill="var(--hue)" />
            </marker>
          </defs>
          {edges.map((e, i) => {
            const a = pos.get(e.from)!, b = pos.get(e.to)!;
            const [ax, ay] = [a.x + W / 2, a.y + H / 2], [bx, by] = [b.x + W / 2, b.y + H / 2];
            const len = Math.hypot(bx - ax, by - ay) || 1;
            const [dx, dy] = [(bx - ax) / len, (by - ay) / len];
            const [x1, y1] = exit(ax, ay, dx, dy);
            const [x2, y2] = exit(bx, by, -dx, -dy);
            const on = active(e, i);
            return (
              <g key={i}>
                <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={on ? "var(--hue)" : "var(--dim)"} strokeWidth={on ? 2 : 1.2} markerEnd={`url(#${on ? "arr-on" : "arr"})`} style={{ transition: "stroke 200ms" }} />
                {e.label && (
                  <text x={(x1 + x2) / 2} y={(y1 + y2) / 2 - 5} textAnchor="middle" fontSize="10" fill={on ? "var(--heading)" : "var(--muted)"}>
                    {e.label}
                  </text>
                )}
              </g>
            );
          })}
          {nodes.map((n) => {
            const p = pos.get(n.id)!;
            const isSel = sel === n.id;
            const lit = isSel || (trace >= 0 && edges.slice(0, trace + 1).some((e) => e.from === n.id || e.to === n.id));
            return (
              <g key={n.id} onClick={() => { setTrace(-1); setSel(isSel ? null : n.id); }} className="cursor-pointer" role="button" aria-label={n.label} tabIndex={-1}>
                <rect x={p.x} y={p.y} width={W} height={H} rx={n.kind === "store" ? 10 : 3} fill={isSel ? "var(--surface-2)" : "var(--surface)"} stroke={lit ? "var(--hue)" : n.kind === "boundary" ? "var(--muted)" : "var(--border)"} strokeDasharray={n.kind === "external" ? "4 3" : n.kind === "boundary" ? "2 2" : undefined} strokeWidth={lit ? 1.6 : 1} />
                <text x={p.x + W / 2} y={p.y + H / 2 + 4} textAnchor="middle" fontSize="12" fill={lit ? "var(--heading)" : "var(--text)"}>
                  {n.label}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
      <p className="mt-2 text-xs text-muted">─ ─ external · ▢ rounded = storage · ┄ execution boundary</p>
      <div className="mt-4 grid gap-6 md:grid-cols-[minmax(0,14rem)_1fr]">
        <ul className="flex flex-wrap md:flex-col gap-1 text-sm" aria-label="components">
          {nodes.map((n) => (
            <li key={n.id}>
              <button type="button" onClick={() => { setTrace(-1); setSel(n.id); }} className={`text-left px-2 py-1.5 rounded-sm w-full transition-colors ${sel === n.id ? "bg-surface-2 text-heading" : "text-muted hover:text-heading"}`}>
                {sel === n.id ? "▸ " : "  "}
                {n.label}
              </button>
            </li>
          ))}
        </ul>
        <div aria-live="polite" className="min-h-28">
          {selected ? (
            <div>
              <p className="text-heading">{selected.label}</p>
              <p className="mt-2">{selected.desc}</p>
              {selected.file && (
                <p className="mt-3 text-sm">
                  <span className="text-muted">implementation · </span>
                  <code className="text-hue break-all">{selected.file}</code>
                </p>
              )}
              <p className="mt-2 text-sm text-muted">
                talks to: {edges.filter((e) => e.from === selected.id || e.to === selected.id).map((e) => (e.from === selected.id ? `→ ${nodes.find((n) => n.id === e.to)?.label}` : `← ${nodes.find((n) => n.id === e.from)?.label}`)).join(" · ") || "—"}
              </p>
            </div>
          ) : trace >= 0 && trace < edges.length ? (
            <p>
              <span className="text-muted">step {trace + 1}/{edges.length} · </span>
              <span className="text-heading">{nodes.find((n) => n.id === edges[trace].from)?.label}</span> → <span className="text-heading">{nodes.find((n) => n.id === edges[trace].to)?.label}</span>
              {edges[trace].label && <span className="text-hue"> · {edges[trace].label}</span>}
            </p>
          ) : (
            <p className="text-muted">Select a component to see what it does and where it lives in the code.</p>
          )}
        </div>
      </div>
    </div>
  );
}
