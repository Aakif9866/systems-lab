import { test } from "node:test";
import assert from "node:assert/strict";
import { Kernel, type ContainerSpec } from "./engine.ts";

const spec = (o: Partial<ContainerSpec> = {}): ContainerSpec => ({ name: "web", image: "alpine-mini", memMaxMB: 64, cpuPercent: 50, pidsMax: 10, hostname: "web-1", network: "none", userns: true, ...o });

test("pid namespace: container init is pid 1 inside but has a different host pid", () => {
  const k = new Kernel();
  const c = k.run(spec());
  assert.match(k.exec("web", "ps"), /^\s+1\s+0\s+\/bin\/sh$/m);
  assert.ok(c.initPid > 1);
  assert.match(k.exec(null, "ps"), new RegExp(`^\\s+${c.initPid}\\s`, "m"), "host sees the real pid");
  assert.doesNotMatch(k.exec("web", "ps"), /systemd/, "container can't see host processes");
});

test("uts + mnt namespaces: hostname and filesystem are isolated", () => {
  const k = new Kernel();
  k.run(spec());
  assert.equal(k.exec("web", "hostname"), "web-1");
  assert.equal(k.exec(null, "hostname"), "lab-host");
  assert.match(k.exec("web", "cat /etc/os-release"), /Alpine-mini/);
  assert.match(k.exec("web", "cat /home/learner/secrets.txt"), /No such file/);
  assert.match(k.exec(null, "cat /home/learner/secrets.txt"), /host-only/);
});

test("net namespace: 'none' is unreachable, bridge containers reach each other", () => {
  const k = new Kernel();
  k.run(spec({ name: "iso", network: "none" }));
  const a = k.run(spec({ name: "a", network: "bridge" }));
  const b = k.run(spec({ name: "b", network: "bridge" }));
  assert.match(k.exec("iso", `ping ${a.ip}`), /unreachable/);
  assert.match(k.exec("a", `ping ${b.ip}`), /64 bytes/);
  assert.match(k.exec("a", "ping 10.88.0.1"), /64 bytes/);
});

test("memory.max: exceeding the limit triggers the cgroup OOM killer", () => {
  const k = new Kernel();
  k.run(spec({ memMaxMB: 64 }));
  assert.match(k.exec("web", "alloc 30"), /allocated/);
  assert.equal(k.exec("web", "alloc 40"), "Killed");
  assert.match(k.exec("web", "cat /sys/fs/cgroup/memory.events"), /oom_kill 1/);
  assert.match(k.exec("web", "free"), /\/ 64 MB/);
});

test("cpu.max: a 30% quota throttles a busy container to ~30% of one core", () => {
  const k = new Kernel(4);
  k.run(spec({ cpuPercent: 30, pidsMax: 20 }));
  for (let i = 0; i < 4; i++) k.exec("web", "spin 1000");
  k.advance(200);
  const cg = k.cgroups.get("/systemslab/web")!;
  assert.ok(Math.abs(cg.cpuTotal / 200 - 0.3) < 0.03, `usage ${cg.cpuTotal / 200}`);
  assert.ok(cg.throttledPeriods >= 18);
});

test("pids.max: fork bombs hit EAGAIN instead of taking down the host", () => {
  const k = new Kernel();
  k.run(spec({ pidsMax: 10 }));
  assert.match(k.exec("web", "fork 100"), /^9 processes created, then: .*EAGAIN/);
  assert.ok(k.exec(null, "ps").includes("systemd"), "host still fine");
});

test("user namespace maps container root to an unprivileged host uid", () => {
  const k = new Kernel();
  k.run(spec({ name: "safe", userns: true }));
  k.run(spec({ name: "risky", userns: false }));
  assert.match(k.exec("safe", "id"), /host sees uid=100000/);
  assert.match(k.exec("risky", "id"), /IS host root/);
});

test("killing pid 1 tears down the whole container; commands are allowlisted", () => {
  const k = new Kernel();
  k.run(spec());
  k.exec("web", "fork 3");
  k.exec("web", "kill 1");
  assert.equal(k.containers.get("web")!.state, "stopped");
  assert.match(k.exec("web", "ps"), /not running/);
  k.run(spec({ name: "x" }));
  assert.match(k.exec("x", "rm -rf /"), /not available/);
});
