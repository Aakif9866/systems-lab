"use client";
import { useRef, useState } from "react";
import { Cluster, type Acks, type Group } from "@/lib/systems/message-broker/engine";
import { Btn, Controls, EventLog, NumField, Panel, Select, Stats, Toggle, fmt, useEngine, useTicker } from "../lab/kit";

const ACKS = ["0", "1", "all"] as const;
const SEM = ["at-least-once", "at-most-once"] as const;

export default function MessageBroker() {
  const [sem, setSem] = useState<Group["semantics"]>("at-least-once");
  const build = (s: Group["semantics"]) => {
    const c = new Cluster({ brokers: 3, replicaLagTicks: 4, minIsr: 2, fetchBatch: 3 });
    c.createTopic("orders", 3, 3);
    c.createGroup("billing", s);
    c.join("billing", "consumer-a");
    c.join("billing", "consumer-b");
    return c;
  };
  const [cl, force, replace] = useEngine(() => build(sem));
  const nextConsumer = useRef(3);
  const [running, setRunning] = useState(true);
  const [rate, setRate] = useState(2);
  const [acks, setAcks] = useState<(typeof ACKS)[number]>("1");
  const [keyed, setKeyed] = useState(true);
  const [consuming, setConsuming] = useState(true);
  const [msg, setMsg] = useState("");
  const seq = useRef(0);

  const ack = (acks === "all" ? "all" : Number(acks)) as Acks;
  const produce = (n: number) => {
    let errors = 0;
    for (let i = 0; i < n; i++) {
      const r = cl.produce("orders", keyed ? `customer-${seq.current % 7}` : null, `order-${seq.current++}`, ack);
      if (r.status === "error") { errors++; setMsg(`produce failed: ${r.error}`); }
    }
    return errors;
  };
  useTicker(() => {
    produce(rate);
    cl.step();
    if (consuming) for (const m of cl.groups.get("billing")!.members) cl.consume("billing", m.id, 3);
    force();
  }, running, 250);

  const g = cl.groups.get("billing")!;
  const parts = cl.topics.get("orders")!;
  const lag = cl.lag("billing");
  const audit = cl.audit("billing");
  const lostAcked = cl.durabilityAudit();
  const owner = (pk: string) => [...g.assignment].find(([, ps]) => ps.includes(pk))?.[0] ?? "—";

  return (
    <div className="space-y-8">
      <Controls>
        <Btn tone="hue" onClick={() => setRunning((r) => !r)}>{running ? "⏸ pause" : "▶ run"}</Btn>
        <NumField label="records/tick" value={rate} min={0} max={20} onChange={setRate} />
        <Select label="acks" value={acks} options={ACKS} onChange={setAcks} />
        <Toggle label="keyed (per-customer order)" value={keyed} onChange={setKeyed} />
        <Toggle label="consumers polling" value={consuming} onChange={setConsuming} />
        <Btn onClick={() => { const e = produce(50); setMsg(`burst of 50 records${e ? `, ${e} rejected` : ""}`); force(); }}>burst ×50</Btn>
      </Controls>
      <Controls>
        {cl.alive.map((alive, b) => (
          <Btn key={b} tone={alive ? "danger" : "hue"} onClick={() => { if (alive) cl.killBroker(b); else cl.restartBroker(b); setMsg(`${alive ? "killed" : "restarted"} broker-${b}`); force(); }}>
            {alive ? `kill broker-${b}` : `restart broker-${b}`}
          </Btn>
        ))}
        <Btn onClick={() => { const id = `consumer-${String.fromCharCode(96 + nextConsumer.current++)}`; cl.join("billing", id); setMsg(`${id} joined → rebalance`); force(); }}>+ consumer</Btn>
        <Btn onClick={() => { const m = g.members[g.members.length - 1]; if (m) { cl.leave("billing", m.id); setMsg(`${m.id} left → rebalance`); force(); } }}>− consumer</Btn>
        <Btn tone="danger" onClick={() => { const m = g.members.find((x) => (g.assignment.get(x.id) ?? []).length); if (!m) return; const r = cl.consume("billing", m.id, 10, 3); setMsg(r.crashed ? `${m.id} crashed after processing 3 of its batch (${sem})` : `${m.id} had nothing to crash on`); force(); }}>crash a consumer mid-batch</Btn>
        <Select label="semantics" value={sem} options={SEM} onChange={(s) => { setSem(s); replace(build(s)); seq.current = 0; nextConsumer.current = 3; setMsg(`fresh cluster, group uses ${s}`); force(); }} />
        <Btn onClick={() => { replace(build(sem)); seq.current = 0; nextConsumer.current = 3; setMsg(""); force(); }}>reset</Btn>
      </Controls>
      {msg && <p className="text-sm text-hue">› {msg}</p>}

      <Panel title="topic 'orders' — partition × broker: log end offset per replica (★ leader, ✓ in ISR)">
        <div className="overflow-x-auto">
          <table className="text-sm tabular-nums w-full min-w-[36rem]">
            <thead className="text-xs text-muted text-left">
              <tr><th className="font-normal py-1">partition</th>{cl.alive.map((a, b) => <th key={b} className="font-normal">broker-{b}{a ? "" : " ✕"}</th>)}<th className="font-normal">HW</th><th className="font-normal">owner</th><th className="font-normal">lag</th></tr>
            </thead>
            <tbody>
              {parts.map((p) => {
                const pk = `orders/${p.id}`;
                return (
                  <tr key={p.id} className="border-t border-border">
                    <td className="py-2 text-heading">p{p.id}{p.leader === null && <span className="text-error"> offline</span>}</td>
                    {cl.alive.map((alive, b) => {
                      const log = p.logs.get(b);
                      if (!log) return <td key={b} className="text-dim">·</td>;
                      return (
                        <td key={b} className={!alive ? "text-dim" : p.leader === b ? "text-hue" : "text-text"}>
                          {log.length}{p.leader === b ? " ★" : ""}{p.isr.has(b) ? " ✓" : ""}
                        </td>
                      );
                    })}
                    <td className="text-heading">{p.hw}</td>
                    <td>{owner(pk)}</td>
                    <td className={lag[pk] > 20 ? "text-error" : ""}>{lag[pk]}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-xs text-muted">Consumers only read below the high watermark. Group generation {g.generation} · members: {g.members.map((m) => m.id).join(", ") || "none"}</p>
      </Panel>

      <Stats items={[
        ["produced / acked", `${fmt(cl.stats.produced)} / ${fmt(cl.stats.ackedCount)}`], ["rejected", cl.stats.rejected], ["pending acks=all", cl.pending.length], ["leader changes", cl.stats.leaderChanges],
        ["processed (unique)", fmt(audit.processed)], ["duplicates", audit.duplicates], ["acked but lost on failover", lostAcked.length], ["records truncated", cl.stats.truncated],
      ]} />
      <p className="text-xs text-muted">Unprocessed acked records still in the log aren&apos;t lost — they&apos;re lag. &quot;Lost on failover&quot; counts acknowledged records missing from every current leader (try acks=1 + kill the leader of a busy partition).</p>

      <Panel title="broker events">
        <EventLog events={cl.emitter.events} height="h-44" />
      </Panel>
    </div>
  );
}
