"use client";
import { useState } from "react";
import { Runtime, loadPreset, type Mode, type Preset, type TaskState } from "@/lib/systems/async-runtime/engine";
import { Btn, Controls, EventLog, NumField, Panel, Select, Stats, Toggle, fmt, pct, useEngine, useTicker } from "../lab/kit";

const PRESETS = ["io-heavy", "cpu-heavy", "imbalanced", "pipeline", "timers"] as const;
const SPEEDS = ["slow", "normal", "fast"] as const;
const MS = { slow: 300, normal: 90, fast: 20 };
const color: Record<TaskState, string> = { queued: "var(--surface-2)", running: "var(--hue)", pending: "var(--muted)", done: "var(--dim)", cancelled: "var(--error)" };

type Cfg = { preset: Preset; workers: number; stealing: boolean; mode: Mode };

export default function AsyncRuntime() {
  const [cfg, setCfg] = useState<Cfg>({ preset: "imbalanced", workers: 4, stealing: true, mode: "async" });
  const build = (c: Cfg) => { const rt = new Runtime({ workers: c.workers, stealing: c.stealing, mode: c.mode }); loadPreset(rt, c.preset); return rt; };
  const [engine, force, replace] = useEngine(() => build(cfg));
  const [running, setRunning] = useState(false);
  const [speed, setSpeed] = useState<(typeof SPEEDS)[number]>("normal");
  const [cmp, setCmp] = useState<string[] | null>(null);

  const apply = (c: Cfg) => { setCfg(c); replace(build(c)); setRunning(false); setCmp(null); force(); };
  useTicker(() => {
    const r = engine;
    if (r.finished() || r.deadlocked()) { setRunning(false); return; }
    r.step();
    force();
  }, running, MS[speed]);

  const compare = () => {
    const run = (c: Partial<Cfg>) => { const r = build({ ...cfg, ...c }); return r.run(); };
    const a = run({ mode: "async" }), s = run({ mode: "sync" }), on = run({ mode: "async", stealing: true }), off = run({ mode: "async", stealing: false });
    setCmp([
      `async: makespan ${a.makespan} ticks${a.deadlocked ? " (DEADLOCK)" : ""} · sync (thread-per-task): ${s.makespan} ticks${s.deadlocked ? " (DEADLOCK)" : ""}`,
      `work stealing on: ${on.makespan} ticks, ${on.steals} steals · off: ${off.makespan} ticks`,
    ]);
  };

  const r = engine;
  const sm = r.summary();
  const tasks = [...r.tasks.values()];

  return (
    <div className="space-y-8">
      <Controls>
        <Select label="workload" value={cfg.preset} options={PRESETS} onChange={(p) => apply({ ...cfg, preset: p })} />
        <NumField label="workers" value={cfg.workers} min={1} max={8} onChange={(w) => apply({ ...cfg, workers: w })} />
        <Select label="mode" value={cfg.mode} options={["async", "sync"] as const} onChange={(m) => apply({ ...cfg, mode: m })} />
        <Toggle label="work stealing" value={cfg.stealing} onChange={(v) => apply({ ...cfg, stealing: v })} />
      </Controls>
      <Controls>
        <Btn tone="hue" onClick={() => setRunning((x) => !x)} disabled={r.finished() || r.deadlocked()}>{running ? "⏸ pause" : "▶ run"}</Btn>
        <Btn onClick={() => { r.step(); force(); }} disabled={running}>step</Btn>
        <Select label="speed" value={speed} options={SPEEDS} onChange={setSpeed} />
        <Btn onClick={() => { r.run(); force(); }}>run to end</Btn>
        <Btn tone="danger" onClick={() => { const t = tasks.find((x) => x.state === "pending" || x.state === "queued"); if (t) { r.cancel(t.id); force(); } }}>cancel a task</Btn>
        <Btn onClick={() => apply(cfg)}>reset</Btn>
        <Btn onClick={compare}>compare modes</Btn>
      </Controls>
      {cmp && <div className="text-sm text-hue space-y-1">{cmp.map((c) => <p key={c}>› {c}</p>)}</div>}
      {sm.deadlocked && <p className="text-sm text-error">deadlock: every thread is blocked waiting on work only an unscheduled task can do</p>}

      <Panel title="workers — the task polled this tick, then its local run queue">
        <div className="space-y-2">
          {r.workers.map((w) => (
            <div key={w.id} className="flex items-center gap-3 text-xs">
              <span className="w-16 shrink-0 text-heading">worker {w.id}</span>
              <span className="w-14 shrink-0 text-center py-1 rounded-sm tabular-nums" style={{ background: w.last !== null ? "var(--hue)" : "var(--surface)", color: w.last !== null ? "var(--bg)" : "var(--muted)" }}>
                {w.last !== null ? `#${w.last}` : cfg.mode === "sync" && w.current !== null ? `⏳#${w.current}` : "idle"}
              </span>
              <div className="flex gap-0.5 overflow-hidden flex-1 min-w-0">
                {w.local.slice(0, 40).map((id) => <span key={id} className="w-3 h-5 shrink-0 rounded-[1px] bg-surface-2" title={`#${id}`} />)}
                {w.local.length > 40 && <span className="text-muted">+{w.local.length - 40}</span>}
              </div>
              <span className="text-muted tabular-nums shrink-0">{pct(sm.utilization[w.id] ?? 0)} busy · {w.steals} steals</span>
            </div>
          ))}
          <div className="flex items-center gap-3 text-xs">
            <span className="w-16 shrink-0 text-muted">injector</span>
            <span className="w-14" />
            <div className="flex gap-0.5 overflow-hidden flex-1">{r.injector.slice(0, 40).map((id) => <span key={id} className="w-3 h-5 shrink-0 rounded-[1px] bg-surface-2" />)}</div>
            <span className="text-muted">{r.injector.length} queued</span>
          </div>
        </div>
      </Panel>

      <Panel title="tasks — click one to cancel it">
        <div className="flex flex-wrap gap-1">
          {tasks.map((t) => (
            <button
              type="button"
              key={t.id}
              onClick={() => { r.cancel(t.id); force(); }}
              title={`#${t.id} ${t.name} · ${t.state}${t.waitingOn ? ` · ${t.waitingOn}` : ""} · ${t.polls} polls, ${t.wakes} wakes`}
              className="w-7 h-7 rounded-sm text-[10px] tabular-nums"
              style={{ background: color[t.state], color: t.state === "running" ? "var(--bg)" : "var(--heading)", outline: t.state === "pending" ? "1px solid var(--muted)" : undefined }}
            >
              {t.id}
            </button>
          ))}
        </div>
        <p className="mt-2 text-xs text-muted">
          {(Object.keys(color) as TaskState[]).map((s) => <span key={s} className="mr-4"><span className="inline-block w-2.5 h-2.5 mr-1 align-middle rounded-[1px]" style={{ background: color[s] }} />{s} {sm.counts[s]}</span>)}
        </p>
      </Panel>

      <Stats items={[
        ["tick", sm.tick], ["makespan", sm.makespan ? `${sm.makespan} ticks` : "—"], ["avg task latency", `${fmt(sm.avgLatency, 1)} ticks`], ["polls (ready / pending)", `${sm.polls} (${sm.readyPolls} / ${sm.pendingPolls})`],
        ["wakes", sm.wakes], ["steals / tasks stolen", `${sm.steals} / ${sm.stolenTasks}`], ["timer fires / io ready", `${sm.timerFires} / ${sm.ioReady}`], ["channel max / cap", Object.values(sm.channelMax).map((c) => `${c.max}/${c.cap}`).join(" ") || "—"],
      ]} />

      <Panel title="runtime events — poll, pending, wake, steal">
        <EventLog events={r.emitter.events} height="h-40" />
      </Panel>
    </div>
  );
}
