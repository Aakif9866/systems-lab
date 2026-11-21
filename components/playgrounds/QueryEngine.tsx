"use client";
import { useMemo, useState } from "react";
import { SAMPLE_QUERIES, execute, sampleCatalog, type JoinStrategy, type PlanNode } from "@/lib/systems/query-engine/engine";
import { Btn, Controls, Panel, Select, Stats, Toggle, fmt } from "../lab/kit";

const catalog = sampleCatalog();
const JOINS = ["auto", "hash", "sort-merge", "nested-loop"] as const;
const BATCH = ["16", "128", "1024", "4096"] as const;

function PlanTree({ node, depth = 0 }: { node: PlanNode; depth?: number }) {
  const off = node.est ? node.stats.rows / node.est : 0;
  return (
    <>
      <div className="flex flex-wrap gap-x-3 py-1" style={{ paddingLeft: depth * 18 }}>
        <span className="text-dim">{depth ? "└─" : ""}</span>
        <span className="text-hue">{node.name}</span>
        <span className="text-heading break-all">{node.detail}</span>
        <span className="text-muted tabular-nums">est {fmt(node.est)} · actual {fmt(node.stats.rows)}{node.est && (off > 3 || off < 0.33) ? " ⚠" : ""} · {node.stats.batches} batches · {fmt(node.stats.ms, 2)} ms</span>
      </div>
      {node.children.map((c, i) => <PlanTree key={i} node={c} depth={depth + 1} />)}
    </>
  );
}

export default function QueryEngine() {
  const [sql, setSql] = useState(SAMPLE_QUERIES[1]);
  const [query, setQuery] = useState(SAMPLE_QUERIES[1]);
  const [join, setJoin] = useState<JoinStrategy>("auto");
  const [pushdown, setPushdown] = useState(true);
  const [useIndex, setUseIndex] = useState(true);
  const [batch, setBatch] = useState<(typeof BATCH)[number]>("1024");
  const [cmp, setCmp] = useState<{ s: string; ms: number; rows: number; err?: string }[] | null>(null);

  const res = useMemo(() => {
    try { return { r: execute(query, catalog, { join, pushdown, useIndex, batchSize: Number(batch) }), err: null }; }
    catch (e) { return { r: null, err: (e as Error).message }; }
  }, [query, join, pushdown, useIndex, batch]);

  const compare = () => setCmp((["hash", "sort-merge", "nested-loop"] as const).map((s) => {
    try { const r = execute(query, catalog, { join: s, pushdown, useIndex, batchSize: Number(batch) }); return { s, ms: r.ms, rows: r.rows.length }; }
    catch (e) { return { s, ms: NaN, rows: 0, err: (e as Error).message }; }
  }));

  const r = res.r;
  return (
    <div className="space-y-6">
      <Panel title="SQL — tables: users(id, name, country, age) 1,000 rows · orders(id, user_id, amount, status) 5,000 rows · hash indexes on users.id, orders.id, orders.user_id">
        <textarea
          aria-label="SQL query"
          value={sql}
          onChange={(e) => setSql(e.target.value)}
          onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); setQuery(sql); setCmp(null); } }}
          rows={3}
          spellCheck={false}
          className="w-full bg-surface text-heading p-3 rounded-sm text-sm outline-none caret-[var(--accent)]"
        />
      </Panel>
      <div className="flex flex-wrap gap-2">
        {SAMPLE_QUERIES.map((q, i) => <button key={i} type="button" onClick={() => { setSql(q); setQuery(q); setCmp(null); }} className="text-xs bg-surface hover:bg-surface-2 px-2 py-1.5 rounded-sm text-muted hover:text-heading">sample {i + 1}</button>)}
      </div>
      <Controls>
        <Btn tone="hue" onClick={() => { setQuery(sql); setCmp(null); }}>▶ run</Btn>
        <Select label="join" value={join} options={JOINS} onChange={setJoin} />
        <Select label="batch" value={batch} options={BATCH} onChange={setBatch} />
        <Toggle label="predicate pushdown" value={pushdown} onChange={setPushdown} />
        <Toggle label="use indexes" value={useIndex} onChange={setUseIndex} />
        <Btn onClick={compare}>compare join algorithms</Btn>
      </Controls>

      {res.err && <p className="text-error text-sm">error — {res.err}</p>}
      {cmp && (
        <div className="text-sm space-y-1 tabular-nums">
          {cmp.map((c) => <div key={c.s}><span className="text-heading w-28 inline-block">{c.s}</span>{c.err ? <span className="text-error">{c.err}</span> : <span>{fmt(c.ms, 2)} ms · {c.rows} rows</span>}</div>)}
        </div>
      )}

      {r && (
        <>
          <Stats items={[["rows returned", fmt(r.rows.length)], ["total time", `${fmt(r.ms, 2)} ms`], ["batch size", batch], ["root operator", r.plan.name]]} />
          <Panel title="EXPLAIN ANALYZE — estimated vs actual rows (⚠ = estimate off by >3×)">
            <div className="bg-surface rounded-sm p-3 text-xs overflow-x-auto"><PlanTree node={r.plan} /></div>
          </Panel>
          <Panel title={`result${r.rows.length > 50 ? " (first 50 rows)" : ""}`}>
            <div className="overflow-x-auto bg-surface rounded-sm max-h-80">
              <table className="text-xs tabular-nums w-full">
                <thead className="sticky top-0 bg-surface"><tr>{r.columns.map((c) => <th key={c} className="text-left font-normal text-hue px-3 py-2 whitespace-nowrap">{c}</th>)}</tr></thead>
                <tbody>{r.rows.slice(0, 50).map((row, i) => <tr key={i} className="border-t border-border">{row.map((v, j) => <td key={j} className="px-3 py-1 whitespace-nowrap">{v === null ? <span className="text-muted">NULL</span> : String(v)}</td>)}</tr>)}</tbody>
              </table>
            </div>
          </Panel>
        </>
      )}
      <p className="text-xs text-muted">Supported: SELECT [*, cols, COUNT/SUM/AVG/MIN/MAX] FROM t [JOIN t2 ON a = b] [WHERE …] [GROUP BY …] [ORDER BY … DESC] [LIMIT n]. ⌘/ctrl + enter runs.</p>
    </div>
  );
}
