// Mini async runtime, modelled on Tokio's multi-threaded scheduler.
// Real: the poll/wake protocol, per-worker run queues + global injector, work stealing (steal half),
// a reactor with timers and I/O readiness, bounded channels with backpressure, cancellation.
// Simulated: OS threads and time. Workers advance in lock-step "ticks" so every run is
// deterministic and observable; one poll or one compute unit costs one tick of a worker.
import { Emitter, rng } from "../shared.ts";

export type Step =
  | { kind: "compute"; units: number }
  | { kind: "sleep"; ticks: number }
  | { kind: "io"; ticks: number }
  | { kind: "send"; ch: string }
  | { kind: "recv"; ch: string };

export type TaskState = "queued" | "running" | "pending" | "done" | "cancelled";
export type Task = {
  id: number; name: string; steps: Step[]; pc: number; progress: number; state: TaskState;
  polls: number; wakes: number; spawnedAt: number; doneAt?: number; waitingOn?: string; pinnedTo?: number; fired?: boolean;
};
type Channel = { cap: number; buf: number[]; sendWaiters: number[]; recvWaiters: number[]; maxLen: number };
export type Worker = { id: number; local: number[]; current: number | null; busy: number; polls: number; steals: number; idle: number; last: number | null };
export type Mode = "async" | "sync";
export type RuntimeConfig = { workers: number; stealing: boolean; mode: Mode; seed?: number };

export class Runtime {
  tick = 0;
  tasks = new Map<number, Task>();
  workers: Worker[];
  injector: number[] = [];
  timers: { at: number; task: number; kind: "timer" | "io" }[] = [];
  channels = new Map<string, Channel>();
  cfg: RuntimeConfig;
  emitter: Emitter;
  stats = { polls: 0, wakes: 0, steals: 0, stolenTasks: 0, timerFires: 0, ioReady: 0, readyPolls: 0, pendingPolls: 0 };
  private nextId = 1;
  private rand: () => number;

  constructor(cfg: RuntimeConfig, emitter = new Emitter("async-runtime", 600)) {
    if (cfg.workers < 1 || cfg.workers > 16) throw new Error("workers must be 1..16");
    this.cfg = cfg;
    this.emitter = emitter;
    this.rand = rng(cfg.seed ?? 1);
    this.workers = Array.from({ length: cfg.workers }, (_, id) => ({ id, local: [], current: null, busy: 0, polls: 0, steals: 0, idle: 0, last: null }));
  }

  channel(name: string, cap: number) {
    if (cap < 1) throw new Error("channel capacity must be >= 1");
    this.channels.set(name, { cap, buf: [], sendWaiters: [], recvWaiters: [], maxLen: 0 });
  }

  spawn(name: string, steps: Step[], onWorker?: number): number {
    const id = this.nextId++;
    this.tasks.set(id, { id, name, steps, pc: 0, progress: 0, state: "queued", polls: 0, wakes: 0, spawnedAt: this.tick });
    if (onWorker !== undefined && this.cfg.mode === "async") this.workers[onWorker % this.workers.length].local.push(id);
    else this.injector.push(id);
    this.emitter.emit("task_spawned", onWorker !== undefined ? `worker-${onWorker}` : "injector", { task: id, name });
    return id;
  }

  cancel(id: number) {
    const t = this.tasks.get(id);
    if (!t || t.state === "done" || t.state === "cancelled") return false;
    t.state = "cancelled";
    t.doneAt = this.tick;
    // drop it from every queue and waiter list; dropping the future releases its resources
    this.injector = this.injector.filter((x) => x !== id);
    for (const w of this.workers) { w.local = w.local.filter((x) => x !== id); if (w.current === id) w.current = null; }
    this.timers = this.timers.filter((x) => x.task !== id);
    for (const ch of this.channels.values()) { ch.sendWaiters = ch.sendWaiters.filter((x) => x !== id); ch.recvWaiters = ch.recvWaiters.filter((x) => x !== id); }
    this.emitter.emit("task_cancelled", "runtime", { task: id });
    return true;
  }

  /** Waker::wake — make a pending task runnable again. */
  private wake(id: number, from: string, toWorker?: number) {
    const t = this.tasks.get(id);
    if (!t || t.state !== "pending") return;
    t.state = "queued";
    t.wakes++;
    t.waitingOn = undefined;
    this.stats.wakes++;
    if (t.pinnedTo !== undefined) { /* sync mode: the blocked thread simply resumes */ }
    else if (toWorker !== undefined) this.workers[toWorker].local.push(id);
    else this.injector.push(id);
    this.emitter.emit("task_woken", from, { task: id });
  }

  /** Future::poll — run the task until it needs to wait (Pending), yields, or finishes (Ready). */
  private poll(t: Task, w: Worker): "ready" | "pending" | "yield" {
    t.polls++;
    this.stats.polls++;
    w.polls++;
    while (t.pc < t.steps.length) {
      const s = t.steps[t.pc];
      switch (s.kind) {
        case "compute":
          t.progress++;
          if (t.progress >= s.units) { t.pc++; t.progress = 0; }
          // one unit of CPU work per poll; cooperative yield back to the scheduler
          return t.pc >= t.steps.length ? "ready" : "yield";
        case "sleep":
        case "io": {
          if (t.fired) { t.fired = false; t.pc++; continue; }
          this.timers.push({ at: this.tick + s.ticks, task: t.id, kind: s.kind === "sleep" ? "timer" : "io" });
          t.waitingOn = `${s.kind} ${s.ticks} ticks`;
          return "pending";
        }
        case "send": {
          const ch = this.channels.get(s.ch)!;
          if (ch.buf.length < ch.cap) {
            ch.buf.push(t.id);
            ch.maxLen = Math.max(ch.maxLen, ch.buf.length);
            const r = ch.recvWaiters.shift();
            if (r !== undefined) this.wake(r, `chan:${s.ch}`, this.cfg.mode === "async" ? w.id : undefined);
            t.pc++;
            continue;
          }
          ch.sendWaiters.push(t.id);
          t.waitingOn = `send ${s.ch} (full)`;
          return "pending";
        }
        case "recv": {
          const ch = this.channels.get(s.ch)!;
          if (ch.buf.length > 0) {
            ch.buf.shift();
            const snd = ch.sendWaiters.shift();
            if (snd !== undefined) this.wake(snd, `chan:${s.ch}`, this.cfg.mode === "async" ? w.id : undefined);
            t.pc++;
            continue;
          }
          ch.recvWaiters.push(t.id);
          t.waitingOn = `recv ${s.ch} (empty)`;
          return "pending";
        }
      }
    }
    return "ready";
  }

  private findWork(w: Worker): number | undefined {
    if (w.local.length) return w.local.shift();
    if (this.injector.length) return this.injector.shift();
    if (!this.cfg.stealing || this.cfg.mode === "sync") return undefined;
    // steal half of a random victim's queue (from the back), like Tokio
    const victims = this.workers.filter((v) => v !== w && v.local.length > 0);
    if (!victims.length) return undefined;
    const v = victims[Math.floor(this.rand() * victims.length)];
    const n = Math.ceil(v.local.length / 2);
    const stolen = v.local.splice(v.local.length - n, n);
    w.local.push(...stolen);
    w.steals++;
    this.stats.steals++;
    this.stats.stolenTasks += n;
    this.emitter.emit("work_stolen", `worker-${w.id}`, { from: `worker-${v.id}`, tasks: n });
    return w.local.shift();
  }

  step(): void {
    // 1. reactor: fire due timers / I/O readiness
    const due = this.timers.filter((x) => x.at <= this.tick);
    this.timers = this.timers.filter((x) => x.at > this.tick);
    for (const d of due) {
      const t = this.tasks.get(d.task);
      if (!t || t.state !== "pending") continue;
      t.fired = true;
      if (d.kind === "timer") this.stats.timerFires++;
      else this.stats.ioReady++;
      this.emitter.emit(d.kind === "timer" ? "timer_fired" : "io_ready", "reactor", { task: t.id });
      this.wake(t.id, "reactor");
    }
    // 2. each worker runs one poll this tick
    for (const w of this.workers) {
      w.last = null;
      let id: number | undefined;
      if (this.cfg.mode === "sync" && w.current !== null) {
        const cur = this.tasks.get(w.current)!;
        if (cur.state === "pending") { w.idle++; continue; } // thread is blocked: can't run anything else
        id = w.current;
      } else id = this.findWork(w);
      if (id === undefined) { w.idle++; continue; }
      const t = this.tasks.get(id)!;
      if (t.state === "done" || t.state === "cancelled") continue;
      t.state = "running";
      w.last = id;
      if (this.cfg.mode === "sync") { w.current = id; t.pinnedTo = w.id; }
      w.busy++;
      const r = this.poll(t, w);
      if (r === "ready") {
        t.state = "done";
        t.doneAt = this.tick + 1;
        this.stats.readyPolls++;
        if (w.current === id) w.current = null;
        this.emitter.emit("task_completed", `worker-${w.id}`, { task: id, latency: t.doneAt - t.spawnedAt, polls: t.polls });
      } else if (r === "pending") {
        t.state = "pending";
        this.stats.pendingPolls++;
        this.emitter.emit("task_pending", `worker-${w.id}`, { task: id, waitingOn: t.waitingOn });
      } else {
        t.state = "queued";
        if (this.cfg.mode === "async") w.local.push(id);
      }
    }
    this.tick++;
  }

  finished(): boolean {
    for (const t of this.tasks.values()) if (t.state !== "done" && t.state !== "cancelled") return false;
    return true;
  }

  /** Deadlock: nothing runnable, nothing scheduled in the reactor, yet tasks remain. */
  deadlocked(): boolean {
    if (this.finished() || this.timers.length) return false;
    // sync mode: every OS thread is blocked on something only another (unscheduled) task can do
    if (this.cfg.mode === "sync" && this.workers.every((w) => w.current !== null && this.tasks.get(w.current)!.state === "pending")) return true;
    for (const t of this.tasks.values()) if (t.state === "queued" || t.state === "running") return false;
    return true;
  }

  run(maxTicks = 20_000) {
    while (!this.finished() && this.tick < maxTicks && !this.deadlocked()) this.step();
    return this.summary();
  }

  summary() {
    const tasks = [...this.tasks.values()];
    const done = tasks.filter((t) => t.state === "done");
    const lat = done.map((t) => t.doneAt! - t.spawnedAt).sort((a, b) => a - b);
    const counts = { queued: 0, running: 0, pending: 0, done: 0, cancelled: 0 } as Record<TaskState, number>;
    for (const t of tasks) counts[t.state]++;
    return {
      tick: this.tick,
      makespan: done.length ? Math.max(...done.map((t) => t.doneAt!)) : 0,
      counts,
      avgLatency: lat.length ? lat.reduce((a, b) => a + b, 0) / lat.length : 0,
      utilization: this.workers.map((w) => (w.busy + w.idle ? w.busy / (w.busy + w.idle) : 0)),
      deadlocked: this.deadlocked(),
      channelMax: Object.fromEntries([...this.channels].map(([k, c]) => [k, { max: c.maxLen, cap: c.cap }])),
      ...this.stats,
    };
  }
}

export type Preset = "io-heavy" | "cpu-heavy" | "imbalanced" | "pipeline" | "timers";

export function loadPreset(rt: Runtime, preset: Preset, scale = 1) {
  const r = rng(42);
  const n = (x: number) => Math.max(1, Math.round(x * scale));
  switch (preset) {
    case "io-heavy":
      for (let i = 0; i < n(40); i++) rt.spawn(`req-${i}`, [{ kind: "compute", units: 1 }, { kind: "io", ticks: 20 }, { kind: "compute", units: 1 }]);
      break;
    case "cpu-heavy":
      for (let i = 0; i < n(16); i++) rt.spawn(`crunch-${i}`, [{ kind: "compute", units: 15 }]);
      break;
    case "imbalanced":
      for (let i = 0; i < n(24); i++) rt.spawn(`job-${i}`, [{ kind: "compute", units: 8 }], 0);
      break;
    case "pipeline": {
      rt.channel("jobs", 4);
      const items = n(30);
      const prod: Step[] = [], cons: Step[] = [];
      for (let i = 0; i < items; i++) prod.push({ kind: "compute", units: 1 }, { kind: "send", ch: "jobs" });
      for (let i = 0; i < items; i++) cons.push({ kind: "recv", ch: "jobs" }, { kind: "compute", units: 3 });
      rt.spawn("producer", prod);
      rt.spawn("consumer", cons);
      break;
    }
    case "timers":
      for (let i = 0; i < n(30); i++) rt.spawn(`timer-${i}`, [{ kind: "sleep", ticks: 5 + Math.floor(r() * 55) }, { kind: "compute", units: 2 }]);
      break;
  }
}
