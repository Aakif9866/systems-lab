// MODEL of how a Linux container runtime uses kernel primitives — not real isolation.
// A browser cannot create namespaces or cgroups, so this file models the kernel objects a runtime
// manipulates: the process table, pid/mnt/uts/net/ipc/user namespaces, cgroup v2 controllers
// (memory.max + OOM killer, cpu.max quota/period throttling, pids.max), pivot_root into an image
// rootfs, and veth pairs on a bridge. The *rules* are the kernel's; the *kernel* is simulated.
import { Emitter } from "../shared.ts";

export type NsKind = "pid" | "mnt" | "uts" | "net" | "ipc" | "user";
type Ns = { id: number; kind: NsKind; owner: string; pidNext: number; fs?: Map<string, string>; hostname?: string; ifaces?: { name: string; ip: string }[]; uidBase?: number };
export type Proc = {
  hostPid: number; nsPids: Map<number, number>; ppid: number; cmd: string; ns: Record<NsKind, number>;
  cgroup: string; state: "running" | "sleeping" | "killed" | "exited"; memMB: number; cpuNeed: number; cpuUsed: number;
};
export type Cgroup = {
  path: string; memMaxMB: number; cpuQuota: number; cpuPeriod: number; pidsMax: number;
  memCurrentMB: number; usageInPeriod: number; throttledPeriods: number; periods: number; oomKills: number; cpuTotal: number; lastPeriodUsage: number; throttled: boolean;
};
export type Container = { name: string; image: string; initPid: number; cgroup: string; state: "created" | "running" | "stopped"; ip?: string; userns: boolean };
export type ContainerSpec = { name: string; image: string; memMaxMB: number; cpuPercent: number; pidsMax: number; hostname: string; network: "none" | "bridge"; userns: boolean };

const IMAGES: Record<string, Map<string, string>> = {
  "alpine-mini": new Map([
    ["/bin/sh", "<busybox>"], ["/etc/os-release", "NAME=Alpine-mini\nVERSION=3.0"], ["/etc/hostname", ""], ["/etc/passwd", "root:x:0:0:root:/root:/bin/sh"], ["/root/.profile", "export PS1='# '"], ["/tmp/.keep", ""],
  ]),
  "debian-slim": new Map([
    ["/bin/bash", "<bash>"], ["/bin/sh", "<dash>"], ["/etc/os-release", "NAME=Debian-slim\nVERSION=12"], ["/etc/hostname", ""], ["/etc/passwd", "root:x:0:0:root:/root:/bin/bash"], ["/usr/bin/apt", "<apt>"], ["/var/lib/dpkg/status", "..."],
  ]),
};
export const IMAGE_NAMES = Object.keys(IMAGES);

export class Kernel {
  procs = new Map<number, Proc>();
  ns = new Map<number, Ns>();
  cgroups = new Map<string, Cgroup>();
  containers = new Map<string, Container>();
  host: Record<NsKind, number>;
  cores: number;
  tick = 0;
  emitter: Emitter;
  private nextPid = 1;
  private nextNs = 1;
  private nextIp = 2;

  constructor(cores = 2, emitter = new Emitter("container-runtime", 500)) {
    this.cores = cores;
    this.emitter = emitter;
    const hostFs = new Map([["/etc/hostname", "lab-host"], ["/etc/os-release", "NAME=HostOS"], ["/home/learner/secrets.txt", "host-only file"], ["/var/run/docker.sock", "<socket>"], ["/bin/sh", "<sh>"]]);
    this.host = {
      pid: this.mkNs("pid", "host"), mnt: this.mkNs("mnt", "host", { fs: hostFs }), uts: this.mkNs("uts", "host", { hostname: "lab-host" }),
      net: this.mkNs("net", "host", { ifaces: [{ name: "lo", ip: "127.0.0.1" }, { name: "eth0", ip: "192.168.1.10" }, { name: "lab0 (bridge)", ip: "10.88.0.1" }] }),
      ipc: this.mkNs("ipc", "host"), user: this.mkNs("user", "host", { uidBase: 0 }),
    };
    this.cgroups.set("/", this.mkCgroup("/", Infinity, Infinity, Infinity));
    this.spawn(0, "systemd", this.host, "/");
    this.spawn(1, "sshd", this.host, "/");
    this.spawn(1, "systemslab-agent", this.host, "/");
  }

  private mkNs(kind: NsKind, owner: string, extra: Partial<Ns> = {}): number {
    const id = this.nextNs++;
    this.ns.set(id, { id, kind, owner, pidNext: 1, ...extra });
    return id;
  }
  private mkCgroup(path: string, memMaxMB: number, cpuQuota: number, pidsMax: number): Cgroup {
    return { path, memMaxMB, cpuQuota, cpuPeriod: 10, pidsMax, memCurrentMB: 0, usageInPeriod: 0, throttledPeriods: 0, periods: 0, oomKills: 0, cpuTotal: 0, lastPeriodUsage: 0, throttled: false };
  }

  /** fork/clone: the child gets a pid in its own pid namespace AND in every ancestor (here: host). */
  private spawn(ppid: number, cmd: string, ns: Record<NsKind, number>, cgroup: string): Proc | string {
    const cg = this.cgroups.get(cgroup)!;
    const inCg = [...this.procs.values()].filter((p) => p.cgroup === cgroup && (p.state === "running" || p.state === "sleeping")).length;
    if (inCg >= cg.pidsMax) {
      this.emitter.emit("fork_failed", cgroup, { reason: "pids.max reached", pidsMax: cg.pidsMax });
      return "fork: Resource temporarily unavailable (EAGAIN: pids.max)";
    }
    const hostPid = this.nextPid++;
    const nsPids = new Map<number, number>([[this.host.pid, hostPid]]);
    if (ns.pid !== this.host.pid) { const pidNs = this.ns.get(ns.pid)!; nsPids.set(ns.pid, pidNs.pidNext++); }
    const p: Proc = { hostPid, nsPids, ppid, cmd, ns: { ...ns }, cgroup, state: "sleeping", memMB: 1, cpuNeed: 0, cpuUsed: 0 };
    this.procs.set(hostPid, p);
    cg.memCurrentMB += 1;
    return p;
  }

  /** OCI-style create+start, step by step, emitting each kernel operation. */
  run(spec: ContainerSpec): Container {
    if (this.containers.has(spec.name)) throw new Error(`container '${spec.name}' already exists`);
    if (!/^[a-z0-9][a-z0-9-]{0,30}$/.test(spec.name)) throw new Error("name: lowercase letters, digits, dashes");
    const image = IMAGES[spec.image];
    if (!image) throw new Error(`unknown image ${spec.image}`);
    const cgPath = `/systemslab/${spec.name}`;
    const quota = Math.round((spec.cpuPercent / 100) * 10); // cpu.max "<quota> <period>" with period = 10 ticks
    this.cgroups.set(cgPath, this.mkCgroup(cgPath, spec.memMaxMB, Math.max(1, quota), spec.pidsMax));
    this.emitter.emit("cgroup_created", cgPath, { "memory.max": `${spec.memMaxMB}M`, "cpu.max": `${quota * 10000} 100000`, "pids.max": spec.pidsMax });

    const ns: Record<NsKind, number> = {
      pid: this.mkNs("pid", spec.name), mnt: this.mkNs("mnt", spec.name, { fs: new Map([...image, ["/etc/hostname", spec.hostname]]) }),
      uts: this.mkNs("uts", spec.name, { hostname: spec.hostname }), net: this.mkNs("net", spec.name, { ifaces: [{ name: "lo", ip: "127.0.0.1" }] }),
      ipc: this.mkNs("ipc", spec.name), user: spec.userns ? this.mkNs("user", spec.name, { uidBase: 100000 }) : this.host.user,
    };
    this.emitter.emit("clone", spec.name, { flags: ["CLONE_NEWPID", "CLONE_NEWNS", "CLONE_NEWUTS", "CLONE_NEWNET", "CLONE_NEWIPC", ...(spec.userns ? ["CLONE_NEWUSER"] : [])].join("|") });
    if (spec.userns) this.emitter.emit("uid_map", spec.name, { map: "0 100000 65536" });
    this.emitter.emit("sethostname", spec.name, { hostname: spec.hostname });
    this.emitter.emit("pivot_root", spec.name, { newRoot: `/var/lib/systemslab/${spec.name}/rootfs`, image: spec.image });
    this.emitter.emit("mount", spec.name, { fs: "proc", target: "/proc" });
    let ip: string | undefined;
    if (spec.network === "bridge") {
      ip = `10.88.0.${this.nextIp++}`;
      this.ns.get(ns.net)!.ifaces!.push({ name: "eth0", ip });
      this.ns.get(this.host.net)!.ifaces!.push({ name: `veth-${spec.name}`, ip: "(bridge port)" });
      this.emitter.emit("veth_created", spec.name, { container: "eth0", host: `veth-${spec.name}`, ip, bridge: "lab0" });
    }
    const init = this.spawn(1, image.has("/bin/bash") ? "/bin/bash" : "/bin/sh", ns, cgPath);
    if (typeof init === "string") throw new Error(init);
    this.emitter.emit("cgroup_attach", cgPath, { pid: init.hostPid });
    this.emitter.emit("execve", spec.name, { pid: init.hostPid, nsPid: 1, cmd: init.cmd });
    const c: Container = { name: spec.name, image: spec.image, initPid: init.hostPid, cgroup: cgPath, state: "running", ip, userns: spec.userns };
    this.containers.set(spec.name, c);
    return c;
  }

  stop(name: string) {
    const c = this.containers.get(name);
    if (!c) throw new Error(`no such container ${name}`);
    for (const p of this.procs.values()) if (p.cgroup === c.cgroup && p.state !== "killed" && p.state !== "exited") this.killProc(p, "SIGKILL (container stop)");
    c.state = "stopped";
    this.emitter.emit("container_stopped", name, {});
  }

  remove(name: string) {
    const c = this.containers.get(name);
    if (!c) return;
    if (c.state === "running") this.stop(name);
    for (const [pid, p] of this.procs) if (p.cgroup === c.cgroup) this.procs.delete(pid);
    this.cgroups.delete(c.cgroup);
    this.containers.delete(name);
  }

  private killProc(p: Proc, why: string) {
    p.state = "killed";
    this.cgroups.get(p.cgroup)!.memCurrentMB -= p.memMB;
    p.memMB = 0;
    p.cpuNeed = 0;
    this.emitter.emit("process_killed", p.cgroup, { pid: p.hostPid, cmd: p.cmd, why });
    // pid 1 dying in a pid namespace kills everything in it
    const c = [...this.containers.values()].find((x) => x.initPid === p.hostPid);
    if (c && c.state === "running") {
      for (const q of this.procs.values()) if (q.cgroup === c.cgroup && q !== p && (q.state === "running" || q.state === "sleeping")) { q.state = "killed"; this.cgroups.get(q.cgroup)!.memCurrentMB -= q.memMB; q.memMB = 0; }
      c.state = "stopped";
      this.emitter.emit("container_exited", c.name, { reason: `init (pid 1) ${why}` });
    }
  }

  /** Charge memory to a process; enforce memory.max with the cgroup OOM killer. */
  private charge(p: Proc, mb: number): string | null {
    const cg = this.cgroups.get(p.cgroup)!;
    p.memMB += mb;
    cg.memCurrentMB += mb;
    if (cg.memCurrentMB > cg.memMaxMB) {
      const victims = [...this.procs.values()].filter((q) => q.cgroup === p.cgroup && (q.state === "running" || q.state === "sleeping"));
      const victim = victims.reduce((m, q) => (q.memMB > m.memMB ? q : m));
      cg.oomKills++;
      this.emitter.emit("oom_kill", p.cgroup, { victim: victim.hostPid, cmd: victim.cmd, memMB: victim.memMB, limitMB: cg.memMaxMB });
      this.killProc(victim, "OOM-killed (memory.max exceeded)");
      return victim === p ? "Killed" : `OOM killer chose pid ${victim.hostPid} (${victim.cmd})`;
    }
    return null;
  }

  /** Scheduler tick with cgroup cpu.max quota enforcement (CFS bandwidth control). */
  step() {
    this.tick++;
    const periodStart = this.tick % 10 === 1;
    for (const cg of this.cgroups.values()) if (periodStart) {
      cg.periods++;
      cg.lastPeriodUsage = cg.usageInPeriod;
      cg.usageInPeriod = 0;
      cg.throttled = false;
    }
    let free = this.cores;
    const runnable = [...this.procs.values()].filter((p) => p.cpuNeed > 0 && (p.state === "running" || p.state === "sleeping"));
    // round-robin by rotating start offset each tick
    const order = runnable.map((_, i) => runnable[(i + this.tick) % runnable.length]);
    for (const p of order) {
      if (free <= 0) break;
      const cg = this.cgroups.get(p.cgroup)!;
      if (cg.usageInPeriod >= cg.cpuQuota) {
        if (!cg.throttled) { cg.throttled = true; cg.throttledPeriods++; this.emitter.emit("cpu_throttled", cg.path, { quota: cg.cpuQuota, period: cg.cpuPeriod }); }
        continue;
      }
      p.state = "running";
      p.cpuNeed--;
      p.cpuUsed++;
      cg.usageInPeriod++;
      cg.cpuTotal++;
      free--;
      if (p.cpuNeed === 0) { p.state = "exited"; cg.memCurrentMB -= p.memMB; p.memMB = 0; this.emitter.emit("process_exited", p.cgroup, { pid: p.hostPid, cmd: p.cmd, cpuTicks: p.cpuUsed }); }
    }
  }

  advance(ticks: number) { for (let i = 0; i < ticks; i++) this.step(); }

  private visible(view: Record<NsKind, number>) {
    return [...this.procs.values()].filter((p) => (p.state === "running" || p.state === "sleeping") && p.nsPids.has(view.pid));
  }

  /** Shell-like interpreter. `where` = container name, or null for the host. Allowlisted commands only. */
  exec(where: string | null, line: string): string {
    const c = where ? this.containers.get(where) : null;
    if (where && !c) return `no such container: ${where}`;
    if (c && c.state !== "running") return `container ${c.name} is not running`;
    const view = c ? this.procs.get(c.initPid)!.ns : this.host;
    const [cmd, ...args] = line.trim().split(/\s+/);
    const pidIn = (p: Proc) => p.nsPids.get(view.pid)!;
    switch (cmd) {
      case "ps":
        return ["  PID  PPID  CMD", ...this.visible(view).map((p) => {
          const parent = this.procs.get(p.ppid);
          const ppid = parent && parent.nsPids.has(view.pid) ? pidIn(parent) : 0;
          return `${String(pidIn(p)).padStart(5)} ${String(ppid).padStart(5)}  ${p.cmd}`;
        })].join("\n");
      case "hostname": return this.ns.get(view.uts)!.hostname!;
      case "ls": {
        const fs = this.ns.get(view.mnt)!.fs!;
        const dir = (args[0] ?? "/").replace(/\/?$/, "/");
        const entries = new Set<string>();
        for (const path of fs.keys()) if (path.startsWith(dir)) entries.add(path.slice(dir.length).split("/")[0] + (path.slice(dir.length).includes("/") ? "/" : ""));
        return entries.size ? [...entries].sort().join("  ") : `ls: ${args[0] ?? "/"}: No such file or directory`;
      }
      case "cat": {
        if (args[0]?.startsWith("/sys/fs/cgroup")) {
          const cg = this.cgroups.get(c ? c.cgroup : args[0].replace("/sys/fs/cgroup", "").replace(/\/[^/]+$/, "") || "/");
          if (!cg) return "cat: no such cgroup";
          const f = args[0].split("/").pop();
          const vals: Record<string, string> = { "memory.max": `${cg.memMaxMB === Infinity ? "max" : cg.memMaxMB * 1048576}`, "memory.current": `${cg.memCurrentMB * 1048576}`, "cpu.max": `${cg.cpuQuota === Infinity ? "max" : cg.cpuQuota * 10000} 100000`, "pids.max": `${cg.pidsMax === Infinity ? "max" : cg.pidsMax}`, "cpu.stat": `nr_periods ${cg.periods}\nnr_throttled ${cg.throttledPeriods}`, "memory.events": `oom_kill ${cg.oomKills}` };
          return vals[f!] ?? "cat: unknown cgroup file";
        }
        const v = this.ns.get(view.mnt)!.fs!.get(args[0]);
        return v === undefined ? `cat: ${args[0]}: No such file or directory` : v;
      }
      case "ip": return this.ns.get(view.net)!.ifaces!.map((i, n) => `${n + 1}: ${i.name}  inet ${i.ip}`).join("\n");
      case "ping": {
        const target = args[0];
        if (!target) return "usage: ping <ip>";
        const myIfaces = this.ns.get(view.net)!.ifaces!;
        if (myIfaces.some((i) => i.ip === target)) return `64 bytes from ${target}: icmp_seq=1 ttl=64 time=0.04 ms`;
        const onBridge = (ips: { ip: string }[]) => ips.some((i) => i.ip.startsWith("10.88.0."));
        const targetOnBridge = target.startsWith("10.88.0.") && (target === "10.88.0.1" || [...this.containers.values()].some((x) => x.ip === target && x.state === "running"));
        if (onBridge(myIfaces) && targetOnBridge) return `64 bytes from ${target}: icmp_seq=1 ttl=64 time=0.09 ms (via lab0 bridge)`;
        return `ping: connect: Network is unreachable (this net namespace has: ${myIfaces.map((i) => i.name).join(", ")})`;
      }
      case "id": {
        const base = this.ns.get(view.user)!.uidBase ?? 0;
        return c ? `uid=0(root) gid=0(root)${base ? `   [host sees uid=${base}: unprivileged outside the user namespace]` : "   [no user namespace: this root IS host root]"}` : "uid=1000(learner)";
      }
      case "alloc": {
        const mb = Number(args[0]);
        if (!Number.isFinite(mb) || mb <= 0 || mb > 100000) return "usage: alloc <MB>";
        const p = this.spawn(c ? c.initPid : 1, `alloc ${mb}M`, view, c ? c.cgroup : "/");
        if (typeof p === "string") return p;
        p.ppid = c ? c.initPid : 1;
        const r = this.charge(p, mb - 1);
        return r ?? `allocated ${mb} MB (pid ${pidIn(p)}) — cgroup now ${this.cgroups.get(p.cgroup)!.memCurrentMB} MB`;
      }
      case "spin": {
        const ticks = Number(args[0] ?? 50);
        if (!Number.isFinite(ticks) || ticks <= 0 || ticks > 5000) return "usage: spin <ticks>";
        const p = this.spawn(c ? c.initPid : 1, `spin ${ticks}`, view, c ? c.cgroup : "/");
        if (typeof p === "string") return p;
        p.cpuNeed = ticks;
        return `started cpu-bound pid ${pidIn(p)} needing ${ticks} cpu ticks`;
      }
      case "fork": {
        const n = Math.min(500, Number(args[0] ?? 1));
        let made = 0;
        for (let i = 0; i < n; i++) {
          const p = this.spawn(c ? c.initPid : 1, "sleep infinity", view, c ? c.cgroup : "/");
          if (typeof p === "string") return `${made} processes created, then: ${p}`;
          made++;
        }
        return `${made} processes created`;
      }
      case "kill": {
        const target = this.visible(view).find((p) => pidIn(p) === Number(args[0]));
        if (!target) return `kill: (${args[0]}) - No such process`;
        this.killProc(target, "SIGKILL");
        return "";
      }
      case "free": {
        const cg = this.cgroups.get(c ? c.cgroup : "/")!;
        return `cgroup memory: ${cg.memCurrentMB} MB used / ${cg.memMaxMB === Infinity ? "unlimited" : cg.memMaxMB + " MB"} limit`;
      }
      default:
        return `${cmd}: not available (allowlisted: ps hostname ls cat ip ping id alloc spin fork kill free)`;
    }
  }
}
