"use client";
import { useState } from "react";
import { IMAGE_NAMES, Kernel, type ContainerSpec } from "@/lib/systems/container-runtime/engine";
import { Btn, Controls, EventLog, NumField, Panel, Select, Stats, Terminal, Toggle, useEngine, useTicker } from "../lab/kit";

const KERNEL_OPS = new Set(["cgroup_created", "clone", "uid_map", "sethostname", "pivot_root", "mount", "veth_created", "cgroup_attach", "execve"]);

function Meter({ label, value, max, unit }: { label: string; value: number; max: number; unit: string }) {
  const f = max === Infinity ? 0 : Math.min(1, value / max);
  return (
    <div>
      <p className="text-xs text-muted">{label} <span className="text-heading tabular-nums">{value}{unit} / {max === Infinity ? "max" : `${max}${unit}`}</span></p>
      <div className="mt-1 h-2 bg-surface rounded-sm"><div className="h-2 rounded-sm transition-[width] duration-200" style={{ width: `${f * 100}%`, background: f > 0.9 ? "var(--error)" : "var(--hue)" }} /></div>
    </div>
  );
}

export default function ContainerRuntime() {
  const [kern, force, replace] = useEngine(() => new Kernel(2));
  const [spec, setSpec] = useState<ContainerSpec>({ name: "web", image: "alpine-mini", memMaxMB: 64, cpuPercent: 50, pidsMax: 16, hostname: "web-1", network: "bridge", userns: true });
  const [target, setTarget] = useState<string | null>(null);
  const [msg, setMsg] = useState("");
  const [sched, setSched] = useState(true);
  const [termKey, setTermKey] = useState(0);

  useTicker(() => { kern.step(); force(); }, sched, 100);

  const containers = [...kern.containers.values()];
  const c = target ? kern.containers.get(target) : null;
  const cg = c ? kern.cgroups.get(c.cgroup) : null;
  const hostname = c ? kern.exec(c.name, "hostname") : "lab-host";
  const prompt = c ? `root@${c.state === "running" ? hostname : c.name}#` : "learner@lab-host$";

  const run = () => {
    try {
      const made = kern.run(spec);
      setTarget(made.name);
      setTermKey((x) => x + 1);
      setMsg(`container ${made.name} running — init is pid 1 inside, pid ${made.initPid} on the host${made.ip ? `, eth0 ${made.ip}` : ""}`);
      setSpec((s) => ({ ...s, name: `${s.name.replace(/-\d+$/, "")}-${kern.containers.size + 1}`, hostname: `${s.hostname.replace(/-\d+$/, "")}-${kern.containers.size + 1}` }));
    } catch (e) { setMsg((e as Error).message); }
    force();
  };

  const ops = kern.emitter.events.filter((e) => KERNEL_OPS.has(e.event_type) && (!c || e.source === c.name || e.source === c.cgroup)).slice(-9);

  return (
    <div className="space-y-8">
      <p className="text-sm text-muted">A browser can&apos;t create namespaces or cgroups, so this is a faithful <span className="text-heading">model</span> of the kernel objects a runtime manipulates. The real runtime needs a dedicated Linux host.</p>

      <Panel title="docker run — OCI-style spec">
        <Controls>
          <label className="flex items-center gap-2 text-sm"><span className="text-muted">name</span><input value={spec.name} onChange={(e) => setSpec({ ...spec, name: e.target.value })} className="w-24 bg-surface text-heading px-2 py-1.5 rounded-sm" /></label>
          <Select label="image" value={spec.image} options={IMAGE_NAMES} onChange={(v) => setSpec({ ...spec, image: v })} />
          <NumField label="memory MB" value={spec.memMaxMB} min={4} max={4096} onChange={(v) => setSpec({ ...spec, memMaxMB: v })} />
          <NumField label="cpu %" value={spec.cpuPercent} min={10} max={200} step={10} onChange={(v) => setSpec({ ...spec, cpuPercent: v })} />
          <NumField label="pids.max" value={spec.pidsMax} min={2} max={500} onChange={(v) => setSpec({ ...spec, pidsMax: v })} />
          <label className="flex items-center gap-2 text-sm"><span className="text-muted">hostname</span><input value={spec.hostname} onChange={(e) => setSpec({ ...spec, hostname: e.target.value })} className="w-24 bg-surface text-heading px-2 py-1.5 rounded-sm" /></label>
          <Select label="network" value={spec.network} options={["bridge", "none"] as const} onChange={(v) => setSpec({ ...spec, network: v })} />
          <Toggle label="user namespace" value={spec.userns} onChange={(v) => setSpec({ ...spec, userns: v })} />
          <Btn tone="hue" onClick={run}>▶ run</Btn>
        </Controls>
      </Panel>
      {msg && <p className="text-sm text-hue">› {msg}</p>}

      <Controls>
        <span className="text-sm text-muted">shell into:</span>
        <Btn tone={target === null ? "hue" : "default"} onClick={() => { setTarget(null); setTermKey((x) => x + 1); }}>host</Btn>
        {containers.map((x) => <Btn key={x.name} tone={target === x.name ? "hue" : "default"} onClick={() => { setTarget(x.name); setTermKey((y) => y + 1); }}>{x.name}{x.state !== "running" ? " (stopped)" : ""}</Btn>)}
        {c && c.state === "running" && <Btn tone="danger" onClick={() => { kern.stop(c.name); force(); }}>stop {c.name}</Btn>}
        <Toggle label="scheduler running" value={sched} onChange={setSched} />
        <Btn onClick={() => { replace(); setTarget(null); setMsg(""); setTermKey((x) => x + 1); force(); }}>reset</Btn>
      </Controls>

      <div className="grid grid-cols-1 gap-8 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
        <Terminal key={termKey} prompt={prompt} exec={(l) => { const o = kern.exec(target, l); force(); return o; }} initial={[c ? `inside ${c.name}: try ps · hostname · ls / · cat /etc/os-release · ip · ping 10.88.0.1 · id · alloc 80 · spin 300 · fork 50 · free` : "on the host: try ps · hostname · ls /home/learner · ip — then run a container and compare"]} hint="ps · hostname · ls / · ip · ping <ip> · id · alloc <MB> · spin <ticks> · fork <n> · kill <pid> · free" />
        <div className="space-y-6 min-w-0">
          {c && cg ? (
            <Panel title={`cgroup ${c.cgroup}`}>
              <div className="space-y-3">
                <Meter label="memory.current" value={cg.memCurrentMB} max={cg.memMaxMB} unit=" MB" />
                <Meter label="cpu used last period" value={cg.lastPeriodUsage} max={cg.cpuQuota} unit=" ticks" />
                <Meter label="pids" value={[...kern.procs.values()].filter((p) => p.cgroup === c.cgroup && (p.state === "running" || p.state === "sleeping")).length} max={cg.pidsMax} unit="" />
              </div>
              <div className="mt-4"><Stats items={[["OOM kills", cg.oomKills], ["throttled periods", `${cg.throttledPeriods}/${cg.periods}`], ["cpu ticks total", cg.cpuTotal], ["state", c.state]]} /></div>
            </Panel>
          ) : <Panel title="cgroup"><p className="text-sm text-muted">select a container to see its cgroup controllers</p></Panel>}
          <Panel title="kernel operations the runtime performed">
            <ol className="text-xs space-y-1">
              {ops.length === 0 && <li className="text-muted">run a container to see clone, pivot_root, cgroup writes…</li>}
              {ops.map((e) => <li key={e.seq}><span className="text-hue">{e.event_type}</span> <span className="text-muted break-all">{JSON.stringify(e.payload)}</span></li>)}
            </ol>
          </Panel>
        </div>
      </div>

      {c && c.state === "running" && (
        <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
          <Panel title={`ps — as seen from inside ${c.name} (its pid namespace)`}><pre className="bg-surface rounded-sm p-3 text-xs h-40 overflow-auto">{kern.exec(c.name, "ps")}</pre></Panel>
          <Panel title="ps — as seen from the host"><pre className="bg-surface rounded-sm p-3 text-xs h-40 overflow-auto">{kern.exec(null, "ps")}</pre></Panel>
        </div>
      )}

      <Panel title="kernel events — OOM kills, throttling, fork failures">
        <EventLog events={kern.emitter.events} height="h-40" />
      </Panel>
    </div>
  );
}
