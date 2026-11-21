"use client";
import { useState } from "react";
import { RedisEngine as Engine, formatReply, parseReply, runLoad } from "@/lib/systems/redis-engine/engine";
import { percentile } from "@/lib/systems/shared";
import { Btn, Controls, EventLog, NumField, Panel, Stats, Terminal, Toggle, fmt, useEngine, useTicker } from "../lab/kit";

const visible = (s: string) => s.replace(/\r\n/g, "\\r\\n");

export default function RedisEngine() {
  const make = () => {
    const e = new Engine();
    const cli = e.connect("redis-cli");
    const sub = e.connect("subscriber");
    return { e, cli, sub };
  };
  const [lab, force, replace] = useEngine(make);
  const [clock, setClock] = useState(true);
  const [wire, setWire] = useState<{ req: string; res: string } | null>(null);
  const [inbox, setInbox] = useState<string[]>([]);
  const [load, setLoad] = useState({ clients: 20, commands: 20000, pipeline: 4, read: 80 });
  const [loadRes, setLoadRes] = useState<string | null>(null);
  const [termKey, setTermKey] = useState(0);
  const { e, cli, sub } = lab;

  const drainSub = () => {
    let buf = e.takeOutput(sub);
    if (!buf) return;
    const msgs: string[] = [];
    for (let p = parseReply(buf); p; p = parseReply(buf)) {
      const r = p.r;
      if (r.t === "arr" && r.v && r.v[0]?.t === "bulk" && r.v[0].v === "message") msgs.push(`${(r.v[1] as { v: string }).v}: ${(r.v[2] as { v: string }).v}`);
      buf = buf.slice(p.used);
    }
    if (msgs.length) setInbox((x) => [...x.slice(-20), ...msgs]);
  };

  useTicker(() => { e.advance(100); e.loopOnce(); drainSub(); force(); }, clock, 100);

  const exec = (line: string) => {
    const r = e.command(cli, line);
    setWire({ req: r.request, res: r.raw });
    drainSub();
    force();
    return formatReply(r.reply);
  };

  const keys = [...e.db.entries()].slice(0, 40);
  const mem = e.memory();

  return (
    <div className="space-y-8">
      <Controls>
        <Toggle label="real-time clock (100 ms ticks)" value={clock} onChange={setClock} />
        <Btn onClick={() => { e.advance(1000); e.loopOnce(); force(); }}>+1 s</Btn>
        <Btn onClick={() => { e.advance(10000); e.loopOnce(); force(); }}>+10 s</Btn>
        <Btn onClick={() => { for (let i = 0; i < 200; i++) e.command(cli, `SET temp:${i} x PX ${200 + (i % 50) * 20}`); setWire(null); force(); }}>200 volatile keys</Btn>
        <Btn onClick={() => { e.command(sub, "SUBSCRIBE news"); e.takeOutput(sub); setInbox(["subscribed to 'news' — now PUBLISH news hello"]); force(); }}>subscriber → news</Btn>
        <Btn onClick={() => { replace(); setWire(null); setInbox([]); setLoadRes(null); setTermKey((k) => k + 1); force(); }}>reset</Btn>
      </Controls>

      <div className="grid grid-cols-1 gap-8 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
        <div className="space-y-3">
          <Terminal key={termKey} prompt="127.0.0.1:6379>" exec={exec} initial={["try: SET user:1 ada EX 5 · TTL user:1 · ZADD lb 10 a 20 b · ZREVRANGE lb 0 -1 WITHSCORES · MULTI · INCR n · EXEC · INFO"]} hint="SET k v EX 10 · GET k · INCR n · LPUSH q a b · ZADD z 1 m · PUBLISH news hi" />
          {wire && (
            <div className="text-xs space-y-1 break-all">
              <div><span className="text-muted">→ wire (RESP request) </span><span className="text-heading">{visible(wire.req)}</span></div>
              <div><span className="text-muted">← wire (RESP reply) </span><span className="text-hue">{visible(wire.res)}</span></div>
            </div>
          )}
        </div>
        <div className="space-y-6 min-w-0">
          <Panel title={`keyspace · ${e.db.size} keys · ${e.expires.size} with TTL`}>
            <div className="h-48 overflow-auto bg-surface rounded-sm p-2 text-xs tabular-nums">
              {keys.length === 0 && <p className="text-muted p-1">empty</p>}
              {keys.map(([k, v]) => {
                const ttl = e.expires.get(k);
                return (
                  <div key={k} className="flex gap-2 px-1">
                    <span className="text-hue w-12 shrink-0">{v.type}</span>
                    <span className="text-heading truncate flex-1">{k}</span>
                    <span className={ttl !== undefined && ttl - e.simTime < 1000 ? "text-error" : "text-muted"}>{ttl === undefined ? "∞" : `${Math.max(0, ttl - e.simTime)} ms`}</span>
                  </div>
                );
              })}
            </div>
          </Panel>
          <Panel title="subscriber client inbox (pushed by the server)">
            <div className="h-24 overflow-auto bg-surface rounded-sm p-2 text-xs">{inbox.length ? inbox.map((m, i) => <div key={i}>{m}</div>) : <span className="text-muted">not subscribed</span>}</div>
          </Panel>
        </div>
      </div>

      <Stats items={[
        ["sim time", `${fmt(e.simTime / 1000, 1)} s`], ["commands", fmt(e.stats.commands)], ["hits / misses", `${fmt(e.stats.hits)} / ${fmt(e.stats.misses)}`], ["expired lazy / active", `${e.stats.expiredLazy} / ${e.stats.expiredActive}`],
        ["clients", e.clients.size], ["memory (estimate)", `${fmt(mem.bytes)} B`], ["bytes in / out", `${fmt(e.stats.bytesIn)} / ${fmt(e.stats.bytesOut)}`], ["loop iterations", fmt(e.stats.loopIterations)],
      ]} />

      <Panel title="concurrent client load — real commands through the same event loop, timed in your browser">
        <Controls>
          <NumField label="clients" value={load.clients} min={1} max={500} onChange={(v) => setLoad({ ...load, clients: v })} />
          <NumField label="commands" value={load.commands} min={100} max={200000} step={1000} onChange={(v) => setLoad({ ...load, commands: v })} />
          <NumField label="pipeline" value={load.pipeline} min={1} max={64} onChange={(v) => setLoad({ ...load, pipeline: v })} />
          <NumField label="read %" value={load.read} min={0} max={100} onChange={(v) => setLoad({ ...load, read: v })} />
          <Btn tone="hue" onClick={() => {
            const r = runLoad(e, { clients: load.clients, commands: load.commands, keys: 1000, readRatio: load.read / 100, pipeline: load.pipeline });
            const l = r.latencyIterations;
            setLoadRes(`${fmt(r.commands)} commands in ${fmt(r.ms, 1)} ms → ${fmt(r.opsPerSec)} ops/s (measured) · queue wait p50 ${percentile(l, 50)} / p99 ${percentile(l, 99)} loop iterations`);
            force();
          }}>run load</Btn>
        </Controls>
        {loadRes && <p className="mt-3 text-sm text-hue">› {loadRes}</p>}
        <p className="mt-2 text-xs text-muted">Sockets are simulated: bytes go straight into each client&apos;s input buffer. Parsing, dispatch and data structures are the real work being timed.</p>
      </Panel>

      <Panel title="server events">
        <EventLog events={e.emitter.events} height="h-40" />
      </Panel>
    </div>
  );
}
