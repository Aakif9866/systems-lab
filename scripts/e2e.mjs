// Browser E2E: drives headless Chrome over CDP — clicks real buttons, types into real inputs, asserts on the DOM.
// Usage: pnpm build && npx serve out (or any static server) then: node scripts/e2e.mjs http://localhost:4173
// Set CHROME=/path/to/chrome if it is not in the default macOS location.
import { spawn } from "node:child_process";

const BASE = process.argv[2] ?? "http://localhost:4173";
const CH = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const prof = `${process.env.TMPDIR ?? "/tmp"}/systems-lab-e2e-profile`;
const chrome = spawn(CH, ["--headless=new", "--disable-gpu", "--no-first-run", `--user-data-dir=${prof}`, "--remote-debugging-port=9333", "--window-size=1280,900", "about:blank"], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let ws, id = 0;
const pending = new Map();
const errors = [];
async function connect() {
  for (let i = 0; i < 50; i++) {
    try {
      const list = await (await fetch("http://localhost:9333/json")).json();
      const page = list.find((t) => t.type === "page");
      ws = new WebSocket(page.webSocketDebuggerUrl);
      await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
      ws.onmessage = (m) => {
        const d = JSON.parse(m.data);
        if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); }
        if (d.method === "Runtime.exceptionThrown") errors.push(d.params.exceptionDetails.exception?.description ?? d.params.exceptionDetails.text);
        if (d.method === "Runtime.consoleAPICalled" && d.params.type === "error") errors.push(d.params.args.map((a) => a.value ?? a.description).join(" "));
      };
      return;
    } catch { await sleep(200); }
  }
  throw new Error("could not connect to chrome");
}
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const evaluate = async (expr) => {
  const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? "eval failed");
  return r.result?.result?.value;
};
const HELPERS = `
  window.$click = (txt) => { const b = [...document.querySelectorAll('button')].find(b => b.textContent.trim().includes(txt)); if (!b) throw new Error('no button: ' + txt); b.click(); return true; };
  window.$set = (sel, v) => { const el = document.querySelector(sel); if (!el) throw new Error('no element: ' + sel); const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v); el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })); return true; };
  window.$cmd = (line) => { $set('input[aria-label="command"]', line); document.querySelector('input[aria-label="command"]').form.requestSubmit(); return true; };
  window.$text = () => document.body.innerText;
`;
async function open(path) {
  errors.length = 0;
  await send("Page.navigate", { url: BASE + path });
  await sleep(2500);
  await evaluate(HELPERS);
}

const results = [];
async function check(name, fn) {
  try { await fn(); results.push([name, errors.length ? `FAIL (console: ${errors[0]})` : "ok"]); }
  catch (e) { results.push([name, "FAIL " + e.message]); }
}
const expectText = async (re, label) => { const t = await evaluate("$text()"); if (!re.test(t)) throw new Error(`expected ${label ?? re}`); };

await connect();
await send("Runtime.enable");
await send("Page.enable");

await check("home lists 10 systems", async () => { await open("/"); const n = await evaluate("document.querySelectorAll('ol li a[href^=\"/projects/\"]').length"); if (n < 10) throw new Error(`only ${n} links`); });
await check("compiler: runs sample, reports type errors", async () => {
  await open("/projects/compiler.html");
  await expectText(/285[\s\S]*610[\s\S]*26/, "sample output");
  await evaluate(`$set('textarea[aria-label="source code"]', 'let x: int = true;')`); await evaluate("$click('compile')"); await sleep(300);
  await expectText(/type error at 1:1/, "type error at 1:1");
  await evaluate(`$set('textarea[aria-label="source code"]', 'fn f(n: int): int { return f(n + 1); } print(f(0));')`); await evaluate("$click('compile')"); await sleep(300);
  await expectText(/stack overflow/, "stack overflow");
});
await check("query engine: index scan + join comparison", async () => {
  await open("/projects/query-engine.html");
  await expectText(/HashAggregate/);
  await evaluate("$click('sample 3')"); await sleep(300);
  await expectText(/IndexScan/);
  await evaluate("$click('sample 2')"); await sleep(200); await evaluate("$click('compare join algorithms')"); await sleep(1500);
  await expectText(/hash\s*[\d.]+ ms[\s\S]*sort-merge\s*[\d.]+ ms[\s\S]*nested-loop/, "three join timings");
});
await check("version control: conflict scenario", async () => {
  await open("/projects/version-control.html");
  await evaluate("$click('conflict')"); await sleep(300);
  await expectText(/CONFLICT in config\.ini/);
  await evaluate("$click('clean merge')"); await sleep(300);
  await expectText(/merged/);
});
await check("allocator: fragmentation makes a big malloc fail", async () => {
  await open("/projects/memory-allocator.html");
  await evaluate("$click('fragment it')"); await sleep(200);
  await evaluate(`$set('input[type=number]', '2000')`); await sleep(100);
  await evaluate("$click('malloc(2000)')"); await sleep(200);
  await expectText(/NULL/, "malloc returned NULL");
  await evaluate("$click('free all')"); await sleep(200);
  await expectText(/external fragmentation[\s\S]{0,5}|0\.0%/);
});
await check("distributed db: kill leader → re-election", async () => {
  await open("/projects/distributed-database.html");
  await sleep(4000);
  await evaluate("$click('kill leader')"); await sleep(8000);
  const t = await evaluate("$text()");
  const lc = Number(/leader changes\s*\n?\s*(\d+)/.exec(t)?.[1] ?? /(\d+)\s*\n\s*leader changes/.exec(t)?.[1]);
  if (!(lc >= 2)) throw new Error(`leader changes = ${lc}`);
});
await check("redis: RESP on the wire", async () => {
  await open("/projects/redis-engine.html");
  await evaluate("$cmd('SET greeting hello EX 5')"); await sleep(200);
  await expectText(/\*5\\r\\n\$3\\r\\nSET/, "RESP request bytes");
  await evaluate("$cmd('TTL greeting')"); await sleep(200);
  await expectText(/\(integer\) [45]/);
  await evaluate("$click('run load')"); await sleep(3000);
  await expectText(/ops\/s \(measured\)/);
});
await check("async runtime: run to end", async () => {
  await open("/projects/async-runtime.html");
  await evaluate("$click('run to end')"); await sleep(300);
  await expectText(/\d+ ticks/);
  await evaluate("$click('compare modes')"); await sleep(500);
  await expectText(/work stealing on: \d+ ticks/);
});
await check("message broker: kill a broker → leader election", async () => {
  await open("/projects/message-broker.html");
  await sleep(1500);
  await evaluate("$click('kill broker-0')"); await sleep(2000);
  await expectText(/killed broker-0/);
  await expectText(/broker-0 ✕/);
});
await check("reverse proxy: dead backend gets ejected", async () => {
  await open("/projects/reverse-proxy.html");
  await sleep(1500);
  await evaluate("$click('up · kill')"); await sleep(3000);
  await expectText(/ejected/);
});
await check("container runtime: run + OOM kill", async () => {
  await open("/projects/container-runtime.html");
  await evaluate("$click('▶ run')"); await sleep(400);
  await expectText(/container web running/);
  await evaluate("$cmd('hostname')"); await sleep(150);
  await expectText(/web-1/);
  await evaluate("$cmd('alloc 80')"); await sleep(200);
  await expectText(/Killed/);
});
await check("architecture diagram: trace a request", async () => {
  await open("/architecture.html");
  await evaluate("$click('follow a request')"); await sleep(1500);
  await expectText(/step \d+\/\d+/);
});

for (const [n, r] of results) console.log(`${r === "ok" ? "ok  " : "FAIL"} ${n}${r === "ok" ? "" : " — " + r}`);
chrome.kill();
process.exit(results.some(([, r]) => r !== "ok") ? 1 : 0);
