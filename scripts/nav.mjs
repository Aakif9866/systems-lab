// Browser navigation checks (client nav, back button, scroll, anchors, active nav, 404). Usage: node scripts/nav.mjs http://localhost:3000
import { spawn } from "node:child_process";
const BASE = process.argv[2] ?? "http://localhost:3000";
const CH = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const chrome = spawn(CH, ["--headless=new","--disable-gpu","--no-first-run",`--user-data-dir=${process.env.TMPDIR ?? "/tmp"}/systems-lab-nav-profile`,"--remote-debugging-port=9340","--window-size=1280,900","about:blank"],{stdio:"ignore"});
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
let ws,id=0;const pend=new Map();const errors=[];
for(let i=0;i<60;i++){try{const l=await (await fetch("http://localhost:9340/json")).json();ws=new WebSocket(l.find(t=>t.type==="page").webSocketDebuggerUrl);await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j});break}catch{await sleep(200)}}
ws.onmessage=m=>{const d=JSON.parse(m.data);if(d.id&&pend.has(d.id)){pend.get(d.id)(d);pend.delete(d.id)}
 if(d.method==="Runtime.exceptionThrown")errors.push(d.params.exceptionDetails.exception?.description??d.params.exceptionDetails.text);
 // Ignore React's dev-only notice about the inline theme boot script (absent in production builds).
 if(d.method==="Runtime.consoleAPICalled"&&d.params.type==="error"&&!d.params.args.some(a=>String(a.value).includes("Encountered a script tag")))errors.push(d.params.args.map(a=>a.value??a.description).join(" ").slice(0,200));};
const send=(method,params={})=>new Promise(r=>{const i=++id;pend.set(i,r);ws.send(JSON.stringify({id:i,method,params}))});
const ev=async e=>{const r=await send("Runtime.evaluate",{expression:e,awaitPromise:true,returnByValue:true});if(r.result?.exceptionDetails)throw new Error(r.result.exceptionDetails.exception?.description);return r.result?.result?.value};
await send("Runtime.enable");await send("Page.enable");
const res=[];const check=async(n,f)=>{const before=errors.length;try{await f();res.push([n,errors.length>before?"FAIL console: "+errors[before]:"ok"])}catch(e){res.push([n,"FAIL "+e.message])}};
const clickLink=(sel)=>ev(`(()=>{const a=document.querySelector(${JSON.stringify(sel)});if(!a)throw new Error('no link '+${JSON.stringify(sel)});a.click();return a.getAttribute('href')})()`);
const h1=()=>ev("document.querySelector('h1')?.innerText");
const path=()=>ev("location.pathname+location.hash");
await send("Page.navigate",{url:BASE+"/"});await sleep(3000);

await check("home → project via list (client nav)",async()=>{await clickLink('a[href="/projects/compiler"]');await sleep(2500);if(await path()!=="/projects/compiler")throw new Error(await path());if(!/Compiler/.test(await h1()))throw new Error("h1 "+await h1());
  if(!/285/.test(await ev("document.body.innerText")))throw new Error("compiler playground didn't mount");});
await check("diagram selection resets when moving to next project",async()=>{
  await ev(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='lexer'||b.textContent.trim().endsWith('lexer')).click()`);await sleep(200);
  if(!/Turns characters into tokens/.test(await ev("document.body.innerText")))throw new Error("could not select lexer");
  await clickLink('nav[aria-label="more systems"] a:last-child');await sleep(2500);
  if(!/redis-engine/.test(await path()))throw new Error(await path());
  const t=await ev("document.body.innerText");
  if(!/Select a component to see what it does/.test(t))throw new Error("inspector kept stale selection from previous project");});
await check("next link lands at top of page",async()=>{
  await ev("window.scrollTo(0, document.body.scrollHeight)");await sleep(200);
  await clickLink('nav[aria-label="more systems"] a:last-child');await sleep(2500);
  const y=await ev("Math.round(window.scrollY)");if(y>50)throw new Error("scrollY "+y);
  if(!/async-runtime/.test(await path()))throw new Error(await path());});
await check("playground swaps to the new engine",async()=>{if(!/workload/.test(await ev("document.body.innerText"))||/127\.0\.0\.1:6379/.test(await ev("document.body.innerText")))throw new Error("wrong playground");});
await check("browser back returns to previous project",async()=>{await ev("history.back()");await sleep(2000);if(!/redis-engine/.test(await path()))throw new Error(await path());if(!/Redis/.test(await h1()))throw new Error(await h1());});
await check("section TOC anchors scroll to the section",async()=>{await clickLink('nav[aria-label="sections"] a[href="#experiments"]');await sleep(800);
  const top=await ev("Math.round(document.getElementById('experiments').getBoundingClientRect().top)");if(top<0||top>120)throw new Error("section top at "+top);});
await check("breadcrumb back to systems",async()=>{await clickLink('header p a[href="/"]');await sleep(2000);if(await path()!=="/")throw new Error(await path());});
await check("header nav: architecture → roadmap → home",async()=>{for(const [href,re] of [["/architecture",/full platform/],["/roadmap",/How it gets built/],["/",/systems-lab --list/]]){await clickLink(`header nav a[href="${href}"]`);await sleep(1800);if(!re.test(await h1()))throw new Error(href+" h1="+await h1());}});
await check("header nav marks the current page",async()=>{await clickLink('header nav a[href="/roadmap"]');await sleep(1500);const cur=await ev(`document.querySelector('header nav a[aria-current="page"]')?.getAttribute('href')`);if(cur!=="/roadmap")throw new Error("aria-current="+cur);});
await check("project page highlights ~/systems in nav",async()=>{await send("Page.navigate",{url:BASE+"/projects/query-engine"});await sleep(3000);const cur=await ev(`document.querySelector('header nav a[aria-current="page"]')?.getAttribute('href')`);if(cur!=="/")throw new Error("aria-current="+cur);});
await check("roadmap table links work",async()=>{await send("Page.navigate",{url:BASE+"/roadmap"});await sleep(2500);await clickLink('table a[href="/projects/message-broker"]');await sleep(2500);if(!/Message Broker/.test(await h1()))throw new Error(await h1());});
await check("learning path links work",async()=>{await send("Page.navigate",{url:BASE+"/"});await sleep(2500);await clickLink('section[aria-labelledby="paths-h"] a[href="/projects/version-control"]');await sleep(2500);if(!/Version Control/.test(await h1()))throw new Error(await h1());});
await check("404 page offers a way back",async()=>{await send("Page.navigate",{url:BASE+"/projects/does-not-exist"});await sleep(2500);const t=await ev("document.body.innerText");if(!/systems-lab/.test(t)||!/not found|404/i.test(t))throw new Error("404 page: "+t.slice(0,120));if(!(await ev(`!!document.querySelector('main a[href="/"]')`)))throw new Error("no link home in main");});
await check("keyboard: skip link is first tab stop",async()=>{await send("Page.navigate",{url:BASE+"/"});await sleep(2000);await send("Input.dispatchKeyEvent",{type:"keyDown",key:"Tab",code:"Tab",windowsVirtualKeyCode:9});await send("Input.dispatchKeyEvent",{type:"keyUp",key:"Tab",code:"Tab",windowsVirtualKeyCode:9});await sleep(200);const t=await ev("document.activeElement?.textContent?.trim()");if(t!=="skip to content")throw new Error("first focus: "+t);});
await check("white toggle switches theme, survives reload, switches back",async()=>{await send("Page.navigate",{url:BASE+"/"});await sleep(2000);
  await ev(`[...document.querySelectorAll('header button')].find(b=>b.textContent.includes('white')).click()`);await sleep(300);
  if(await ev("document.documentElement.dataset.theme")!=="light")throw new Error("not light after click");
  const bg=await ev("getComputedStyle(document.body).backgroundColor");if(bg!=="rgb(255, 255, 255)")throw new Error("body bg "+bg);
  await send("Page.reload");await sleep(2500);
  if(await ev("document.documentElement.dataset.theme")!=="light")throw new Error("theme lost on reload");
  if(!(await ev(`[...document.querySelectorAll('header button')].some(b=>b.textContent.includes('black'))`)))throw new Error("toggle label not updated after reload");
  await ev(`[...document.querySelectorAll('header button')].find(b=>b.textContent.includes('black')).click()`);await sleep(300);
  if(await ev("document.documentElement.dataset.theme")!==undefined&&await ev("document.documentElement.dataset.theme")!==null)throw new Error("still light");});
for(const [n,r] of res)console.log(`${r==="ok"?"ok  ":"FAIL"} ${n}${r==="ok"?"":" — "+r}`);
chrome.kill();process.exit(0);
