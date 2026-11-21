"use client";
import { useMemo, useState } from "react";
import { SAMPLE, TernError, compileAndRun, type Expr, type Program, type Stmt } from "@/lib/systems/compiler/engine";
import { Btn, Controls, NumField, Panel, Stats, Toggle, fmt } from "../lab/kit";

const TABS = ["output", "tokens", "ast", "bytecode", "trace"] as const;

function showExpr(e: Expr): string {
  switch (e.k) {
    case "num": case "bool": return String(e.v);
    case "var": return e.name;
    case "un": return `(${e.op}${showExpr(e.e)})`;
    case "bin": return `(${showExpr(e.l)} ${e.op} ${showExpr(e.r)})`;
    case "call": return `${e.name}(${e.args.map(showExpr).join(", ")})`;
    case "arr": return `[${e.items.map(showExpr).join(", ")}]`;
    case "idx": return `${showExpr(e.arr)}[${showExpr(e.i)}]`;
  }
}
function showStmts(b: Stmt[], d: number): string[] {
  const pad = "  ".repeat(d);
  return b.flatMap((s): string[] => {
    switch (s.k) {
      case "let": return [`${pad}Let ${s.name}${s.ann ? `: ${s.ann}` : ""} = ${showExpr(s.init)}`];
      case "assign": return [`${pad}Assign ${s.name} = ${showExpr(s.v)}`];
      case "setidx": return [`${pad}SetIndex ${showExpr(s.arr)}[${showExpr(s.i)}] = ${showExpr(s.v)}`];
      case "print": return [`${pad}Print ${showExpr(s.v)}`];
      case "expr": return [`${pad}Expr ${showExpr(s.e)}`];
      case "ret": return [`${pad}Return ${s.v ? showExpr(s.v) : ""}`];
      case "block": return [`${pad}Block`, ...showStmts(s.body, d + 1)];
      case "while": return [`${pad}While ${showExpr(s.cond)}`, ...showStmts(s.body, d + 1)];
      case "if": return [`${pad}If ${showExpr(s.cond)}`, ...showStmts(s.then, d + 1), ...(s.els ? [`${pad}Else`, ...showStmts(s.els, d + 1)] : [])];
    }
  });
}
const showAst = (p: Program) => [...p.fns.flatMap((f) => [`Fn ${f.name}(${f.params.map((x) => `${x.name}: ${x.type}`).join(", ")}): ${f.ret}`, ...showStmts(f.body, 1)]), "Main", ...showStmts(p.main, 1)].join("\n");

export default function Compiler() {
  const [src, setSrc] = useState(SAMPLE);
  const [code, setCode] = useState(SAMPLE);
  const [opt, setOpt] = useState(true);
  const [gc, setGc] = useState(16);
  const [tab, setTab] = useState<(typeof TABS)[number]>("output");
  const [cmp, setCmp] = useState<string | null>(null);

  const res = useMemo(() => {
    try { return { r: compileAndRun(code, { optimize: opt, gcThreshold: gc }), err: null }; }
    catch (e) { return { r: null, err: e as TernError | Error }; }
  }, [code, opt, gc]);

  const compare = () => {
    try {
      const a = compileAndRun(code, { optimize: false, gcThreshold: gc }), b = compileAndRun(code, { optimize: true, gcThreshold: gc });
      if (!a.ok || !b.ok) return setCmp("fix type errors first");
      setCmp(`optimizer off: ${a.instructions} instructions, ${fmt(a.result.steps)} steps · on: ${b.instructions} instructions, ${fmt(b.result.steps)} steps (${b.optimized.folds} folds, ${b.optimized.deadRemoved} dead statements removed) · output identical: ${a.result.output.join() === b.result.output.join() ? "yes" : "NO"}`);
    } catch (e) { setCmp((e as Error).message); }
  };

  const r = res.r;
  const err = res.err as TernError | null;
  const errors = err ? [err] : r && !r.ok ? r.typeErrors : [];
  const lines = src.split("\n").length;

  return (
    <div className="space-y-6">
      <Controls>
        <Btn tone="hue" onClick={() => setCode(src)}>▶ compile &amp; run</Btn>
        <Toggle label="optimizer" value={opt} onChange={setOpt} />
        <NumField label="GC threshold" value={gc} min={2} max={1000} onChange={setGc} />
        <Btn onClick={compare}>compare optimizer on/off</Btn>
        <Btn onClick={() => { setSrc(SAMPLE); setCode(SAMPLE); }}>reset sample</Btn>
        <span className="text-xs text-muted">⌘/ctrl + enter runs</span>
      </Controls>
      {cmp && <p className="text-sm text-hue">› {cmp}</p>}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Panel title="source.tern">
          <div className="flex bg-surface rounded-sm text-sm">
            <pre aria-hidden="true" className="py-3 pl-3 pr-2 text-dim select-none text-right leading-6">{Array.from({ length: lines }, (_, i) => i + 1).join("\n")}</pre>
            <textarea
              aria-label="source code"
              value={src}
              onChange={(e) => setSrc(e.target.value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); setCode(src); }
                if (e.key === "Tab") { e.preventDefault(); const t = e.currentTarget, s = t.selectionStart; setSrc(src.slice(0, s) + "  " + src.slice(t.selectionEnd)); requestAnimationFrame(() => t.setSelectionRange(s + 2, s + 2)); }
              }}
              spellCheck={false}
              rows={Math.max(18, lines)}
              className="flex-1 min-w-0 bg-transparent text-heading py-3 pr-3 leading-6 outline-none resize-none whitespace-pre overflow-x-auto caret-[var(--accent)]"
            />
          </div>
        </Panel>
        <div className="min-w-0">
          <div role="tablist" className="flex flex-wrap gap-1 mb-2">
            {TABS.map((t) => <button key={t} type="button" role="tab" aria-selected={tab === t} onClick={() => setTab(t)} className={`text-xs px-3 py-1.5 rounded-sm ${tab === t ? "bg-surface-2 text-hue" : "bg-surface text-muted hover:text-heading"}`}>{t}</button>)}
          </div>
          <pre className="h-[27rem] overflow-auto bg-surface rounded-sm p-3 text-xs leading-5 whitespace-pre">
            {errors.length > 0 ? (
              errors.map((e, i) => <div key={i} className="text-error">{"phase" in e ? `${e.phase} error` : "error"}{"line" in e && e.line ? ` at ${e.line}:${e.col}` : ""} — {e.message}</div>)
            ) : !r || !r.ok ? null : tab === "output" ? (
              r.result.output.join("\n") || "(no output)"
            ) : tab === "tokens" ? (
              r.tokens.map((t) => `${String(t.line).padStart(3)}:${String(t.col).padEnd(3)} ${t.kind.padEnd(6)} ${t.text}`).join("\n")
            ) : tab === "ast" ? (
              showAst(r.optimized.prog)
            ) : tab === "bytecode" ? (
              r.chunks.map((c) => [`fn ${c.name} (arity ${c.arity}, locals ${c.locals})`, ...c.code.map((ins, i) => `  ${String(i).padStart(4, "0")}  ${ins.op.padEnd(7)} ${ins.a ?? ""}${ins.b !== undefined ? `, ${ins.b}` : ""}`)].join("\n")).join("\n\n")
            ) : (
              r.result.trace.map((t) => `${t.fn.padEnd(6)} ${String(t.ip).padStart(4, "0")} ${t.op.padEnd(7)} ${String(t.arg ?? "").padEnd(5)} stack: [${t.stack.join(", ")}]`).join("\n") + (r.result.steps > r.result.trace.length ? `\n… first ${r.result.trace.length} of ${fmt(r.result.steps)} steps` : "")
            )}
          </pre>
        </div>
      </div>

      {r && r.ok && (
        <Stats items={[
          ["tokens", r.tokens.length], ["bytecode instructions", r.instructions], ["VM steps", fmt(r.result.steps)], ["run time", `${fmt(r.result.ms, 2)} ms`],
          ["constant folds", r.optimized.folds], ["dead statements removed", r.optimized.deadRemoved], ["GC collections / freed", `${r.result.gc.collections} / ${r.result.gc.freed}`], ["peak live objects", r.result.gc.peakLive],
        ]} />
      )}
      <p className="text-xs text-muted">Language: int, bool, [int]; let, if/else, while, fn, return, print, len(), push(). Functions see only their params and locals. Try a type error like <code className="text-heading">let x: int = true;</code>.</p>
    </div>
  );
}
