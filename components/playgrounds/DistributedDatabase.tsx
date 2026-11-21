"use client";
import { useRef, useState } from "react";
import { RaftCluster } from "@/lib/systems/distributed-database/raft";
import type { ReadStep } from "@/lib/systems/distributed-database/lsm";
import { Btn, Controls, EventLog, NumField, Panel, Select, Stats, Toggle, fmt, useEngine, useTicker } from "../lab/kit";

const SPEEDS = ["slow", "normal", "fast"] as const;
const MS = { slow: 400, normal: 150, fast: 40 };

export default function DistributedDatabase() {
  const make = () => new RaftCluster({ nodes: 5, lsm: { memtableLimit: 8, l0Limit: 3, sstEntries: 12 } });
  const [cluster, force, replace] = useEngine(make);
  const [running, setRunning] = useState(true);
  const [speed, setSpeed] = useState<(typeof SPEEDS)[number]>("normal");
  const [auto, setAuto] = useState(true);
  const [rate, setRate] = useState(1);
  const [sel, setSel] = useState(0);
  const [key, setKey] = useState("user:42");
  const [val, setVal] = useState("ada");
  const [msg, setMsg] = useState("");
  const [readPath, setReadPath] = useState<ReadStep[] | null>(null);
  const counter = useRef(0);

  const tick = () => {
    if (auto) for (let i = 0; i < rate; i++) cluster.write(`k${String(counter.current++ % 40).padStart(2, "0")}`, `v${counter.current}`);
    cluster.step();
    force();
  };
  useTicker(tick, running, MS[speed]);

  const m = cluster.metrics();
  const node = cluster.nodes[sel];
  const nm = m.nodes[sel];

  const reset = () => { replace(); counter.current = 0; setReadPath(null); setMsg(""); force(); };
  const isolateLeader = () => {
    if (m.leader === null) return setMsg("no leader to isolate yet");
    const others = [0, 1, 2, 3, 4].filter((i) => i !== m.leader);
    cluster.partition([[m.leader, others[0]], others.slice(1)]);
    setMsg(`partitioned: {node-${m.leader}, node-${others[0]}} | {${others.slice(1).map((i) => `node-${i}`).join(", ")}}`);
    force();
  };

  return (
    <div className="space-y-8">
      <Controls>
        <Btn tone="hue" onClick={() => setRunning((r) => !r)}>{running ? "⏸ pause" : "▶ run"}</Btn>
        <Btn onClick={tick} disabled={running}>step</Btn>
        <Select label="speed" value={speed} options={SPEEDS} onChange={setSpeed} />
        <Toggle label="auto workload" value={auto} onChange={setAuto} />
        <NumField label="writes/tick" value={rate} min={0} max={10} onChange={setRate} />
        <Btn tone="danger" onClick={() => { if (m.leader !== null) { cluster.kill(m.leader); setMsg(`killed leader node-${m.leader}`); force(); } }}>kill leader</Btn>
        <Btn onClick={isolateLeader}>partition leader</Btn>
        <Btn onClick={() => { cluster.heal(); setMsg("network healed"); force(); }}>heal</Btn>
        <Btn onClick={reset}>reset</Btn>
      </Controls>
      {msg && <p className="text-sm text-hue">› {msg}</p>}

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        {m.nodes.map((n) => (
          <div
            key={n.id}
            className={`p-3 rounded-sm transition-colors ${sel === n.id ? "bg-surface-2" : "bg-surface"} ${!n.alive ? "opacity-60" : ""}`}
            style={{ boxShadow: n.role === "leader" && n.alive ? "inset 0 0 0 1px var(--hue)" : undefined }}
          >
            <button type="button" onClick={() => setSel(n.id)} aria-pressed={sel === n.id} className="w-full text-left">
              <div className="flex justify-between text-sm">
                <span className="text-heading">node-{n.id}</span>
                <span className={n.role === "leader" ? "text-hue" : n.role === "candidate" ? "text-heading" : "text-muted"}>{n.alive ? n.role : "dead"}</span>
              </div>
              <div className="mt-2 text-xs grid grid-cols-2 gap-x-2 gap-y-0.5 tabular-nums">
                <span className="text-muted">term</span><span>{n.term}</span>
                <span className="text-muted">log</span><span>{n.log}</span>
                <span className="text-muted">commit</span><span>{n.commit}</span>
                <span className="text-muted">lag</span><span className={n.lag > 5 ? "text-error" : ""}>{n.role === "leader" ? "—" : n.lag}</span>
                <span className="text-muted">mem/wal</span><span>{n.memtable}/{n.wal}</span>
                <span className="text-muted">L0/L1</span><span>{n.l0}/{n.l1}</span>
                <span className="text-muted">net</span><span>{n.partition === 0 ? "ok" : `part ${n.partition}`}</span>
              </div>
            </button>
            <button
              type="button"
              onClick={() => { if (n.alive) cluster.kill(n.id); else cluster.restart(n.id); force(); }}
              className={`mt-2 text-xs hover:underline ${n.alive ? "text-error" : "text-hue"}`}
            >
              {n.alive ? "kill" : "restart"}
            </button>
          </div>
        ))}
      </div>

      <Stats items={[
        ["tick", m.tick], ["leader", m.leader === null ? "none" : `node-${m.leader}`], ["term", m.term], ["leader changes", m.leaderChanges],
        ["commit p50 / p99", `${m.commitP50} / ${m.commitP99} ticks`], ["writes committed", `${fmt(m.committed)} / ${fmt(m.writes)}`], ["rejected (no leader)", m.rejected], ["msgs in flight / dropped", `${m.inFlight} / ${m.dropped}`],
      ]} />

      <div className="grid grid-cols-1 gap-8 lg:grid-cols-2">
        <Panel title={`client → leader`}>
          <form className="flex flex-wrap gap-2 items-center" onSubmit={(e) => { e.preventDefault(); const r = cluster.write(key, val || null); setMsg(r.ok ? `PUT ${key}=${val} appended at leader node-${r.leader}; acked once committed` : `write failed: ${r.error}`); force(); }}>
            <input aria-label="key" value={key} onChange={(e) => setKey(e.target.value)} className="bg-surface text-heading px-2 py-1.5 rounded-sm w-28 text-sm" />
            <input aria-label="value" value={val} onChange={(e) => setVal(e.target.value)} placeholder="(empty = delete)" className="bg-surface text-heading px-2 py-1.5 rounded-sm w-32 text-sm" />
            <Btn submit>put</Btn>
            <Btn onClick={() => { const r = cluster.read(key, sel); setReadPath(r.error ? null : r.path); setMsg(r.error ? `read failed: ${r.error}` : `GET ${key} on node-${sel} (${r.role}) → ${r.value ?? "(nil)"}`); }}>get on node-{sel}</Btn>
          </form>
          {readPath && (
            <ol className="mt-3 text-xs space-y-0.5">
              {readPath.map((s, i) => (
                <li key={i}><span className="text-muted">{i + 1}.</span> {s.where} <span className={s.result === "hit" ? "text-hue" : s.result === "bloom-false-positive" ? "text-error" : "text-muted"}>{s.result}</span></li>
              ))}
            </ol>
          )}
          <p className="mt-3 text-xs text-muted">Reads from followers can be stale — try reading right after a write, or on a partitioned node.</p>
        </Panel>

        <Panel title={`storage engine · node-${sel}`}>
          <Stats items={[
            ["write amp", fmt(nm.writeAmplification, 2)], ["space amp", fmt(nm.spaceAmplification, 2)], ["flushes / compactions", `${nm.flushes} / ${nm.compactions}`], ["bloom skips / FP", `${nm.bloomSkips} / ${nm.bloomFalsePositives}`],
          ]} />
          <div className="mt-4 text-xs space-y-2">
            <div><span className="text-muted">WAL ({node.store.wal.length}) </span>{node.store.wal.slice(-6).map((r) => <span key={r.lsn} className="mr-2">#{r.lsn} {r.op} {r.key}</span>)}</div>
            <div><span className="text-muted">memtable ({node.store.memtable.size}) </span>{[...node.store.memtable.keys()].sort().slice(0, 10).join(" ")}</div>
            <div><span className="text-muted">L0 </span>{node.store.l0.map((t) => <span key={t.id} className="mr-2 bg-surface px-1">#{t.id} [{t.minKey}…{t.maxKey}] {t.entries.length}</span>)}</div>
            <div><span className="text-muted">L1 </span>{node.store.l1.map((t) => <span key={t.id} className="mr-2 bg-surface px-1">#{t.id} [{t.minKey}…{t.maxKey}] {t.entries.length}</span>)}</div>
            <div><span className="text-muted">raft log tail </span>{node.log.slice(-5).map((e) => <span key={e.id} className="mr-2">{e.index}:t{e.term}:{e.cmd.op === "noop" ? "noop" : `${e.cmd.op} ${e.cmd.key}`}</span>)}</div>
          </div>
        </Panel>
      </div>

      <Panel title="execution events (standard envelope)">
        <EventLog events={cluster.emitter.events} />
      </Panel>
    </div>
  );
}
