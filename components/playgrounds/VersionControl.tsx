"use client";
import { useState } from "react";
import { Repo } from "@/lib/systems/version-control/engine";
import { Btn, Controls, EventLog, Panel, Stats, Terminal, useEngine } from "../lab/kit";

const SCENARIOS: Record<string, string[]> = {
  "clean merge": [
    'write app.txt "line 1\\nline 2\\nline 3\\nline 4\\nline 5"', "add .", 'commit -m "base"', "checkout -b feature",
    'write app.txt "line 1\\nline 2\\nline 3\\nline 4\\nFEATURE line 5"', "add .", 'commit -m "feature edits line 5"', "checkout main",
    'write app.txt "MAIN line 1\\nline 2\\nline 3\\nline 4\\nline 5"', "add .", 'commit -m "main edits line 1"', "merge feature",
  ],
  conflict: [
    'write config.ini "port=80\\nmode=dev"', "add .", 'commit -m "base config"', "checkout -b ops",
    'write config.ini "port=8080\\nmode=dev"', "add .", 'commit -m "ops: port 8080"', "checkout main",
    'write config.ini "port=443\\nmode=dev"', "add .", 'commit -m "main: port 443"', "merge ops",
  ],
  dedup: ['write a.txt "same bytes"', 'write docs/b.txt "same bytes"', "add .", 'commit -m "two files, one blob"'],
};

export default function VersionControl() {
  const [r, force, replace] = useEngine(() => new Repo());
  const [termKey, setTermKey] = useState(0);
  const [initial, setInitial] = useState<string[]>(["try: write hello.txt \"hi\" · add . · commit -m \"first\" · log", "or load a scenario above"]);
  const [obj, setObj] = useState<string | null>(null);
  const [diffPath, setDiffPath] = useState<string | null>(null);
  const exec = (line: string) => { const out = r.exec(line); force(); return out; };
  const load = (name: string) => {
    const fresh = new Repo();
    const out: string[] = [];
    for (const l of SCENARIOS[name]) {
      out.push(`$ ${l}`);
      try { const o = fresh.exec(l); if (o) out.push(o); } catch (e) { out.push(`error: ${(e as Error).message}`); }
    }
    replace(fresh);
    setInitial(out);
    setTermKey((k) => k + 1);
    setObj(null);
  };

  const log = r.log();
  const refsAt = (h: string) => [...r.refs].filter(([, c]) => c === h).map(([b]) => (b === r.head ? `HEAD → ${b}` : b));
  const st = r.status();
  const storage = r.storage();
  const sel = obj ? r.objects.get(obj) : null;

  return (
    <div className="space-y-8">
      <Controls>
        <span className="text-sm text-muted">scenario:</span>
        {Object.keys(SCENARIOS).map((s) => <Btn key={s} onClick={() => load(s)}>{s}</Btn>)}
        <Btn onClick={() => { replace(); setInitial(["fresh repository"]); setTermKey((k) => k + 1); }}>reset</Btn>
      </Controls>

      <div className="grid grid-cols-1 gap-8 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
        <Terminal key={termKey} prompt={`(${r.head})$`} exec={exec} initial={initial} hint="write f.txt hello · add . · commit -m msg · branch x · checkout x · merge x · diff f.txt · cat-file <hash>" />
        <Panel title="commit graph">
          <div className="h-72 overflow-auto bg-surface rounded-sm p-3 text-xs space-y-2">
            {log.length === 0 && <p className="text-muted">no commits yet</p>}
            {log.map((c) => (
              <div key={c.hash} className="flex gap-2">
                <span className={c.parents.length > 1 ? "text-heading" : "text-hue"}>{c.parents.length > 1 ? "◆" : "●"}</span>
                <div className="min-w-0">
                  <button type="button" onClick={() => setObj(c.hash)} className="text-heading hover:underline">{c.hash.slice(0, 7)}</button>
                  {refsAt(c.hash).map((b) => <span key={b} className="ml-2 text-hue">({b})</span>)}
                  <div className="truncate">{c.message}</div>
                  <div className="text-muted">parents: {c.parents.map((p) => p.slice(0, 7)).join(", ") || "root"}</div>
                </div>
              </div>
            ))}
          </div>
        </Panel>
      </div>

      <Stats items={[
        ["branch", st.branch + (st.merging ? " (merging)" : "")], ["blobs", `${storage.blob.count} · ${storage.blob.bytes} B`], ["trees", storage.tree.count], ["commits", storage.commit.count],
        ["staged", st.staged.length], ["modified", st.unstaged.length], ["untracked", st.untracked.length], ["branches", r.refs.size],
      ]} />

      <div className="grid grid-cols-1 gap-8 lg:grid-cols-3">
        <Panel title="object database (hash → object)">
          <div className="h-60 overflow-auto bg-surface rounded-sm p-2 text-xs">
            {[...r.objects].map(([h, o]) => (
              <button type="button" key={h} onClick={() => setObj(h)} className={`block w-full text-left px-1 py-0.5 rounded-sm ${obj === h ? "bg-surface-2 text-heading" : "hover:text-heading"}`}>
                <span className="text-hue w-12 inline-block">{o.type}</span>{h.slice(0, 12)}…
              </button>
            ))}
          </div>
        </Panel>
        <Panel title={sel ? `${sel.type} ${obj!.slice(0, 12)}…` : "inspect an object"}>
          <pre className="h-60 overflow-auto bg-surface rounded-sm p-3 text-xs whitespace-pre-wrap break-all">{sel ? sel.body || "(empty)" : "Click a hash. Trees list mode/type/hash/name; commits point to a tree and parents; blobs are file contents."}</pre>
        </Panel>
        <Panel title="working directory · diff vs index">
          <div className="flex flex-wrap gap-1 mb-2">
            {[...r.work.keys()].sort().map((p) => <button type="button" key={p} onClick={() => setDiffPath(p)} className={`text-xs px-2 py-1 rounded-sm ${diffPath === p ? "bg-surface-2 text-heading" : "bg-surface"}`}>{p}</button>)}
          </div>
          <pre className="h-48 overflow-auto bg-surface rounded-sm p-3 text-xs">
            {diffPath && r.work.has(diffPath)
              ? r.diff(diffPath).map((d, i) => <div key={i} className={d.op === "+" ? "text-hue" : d.op === "-" ? "text-error" : "text-muted"}>{d.op} {d.line}</div>)
              : <span className="text-muted">pick a file — shows its Myers diff against the staged version (and conflict markers after a conflicted merge)</span>}
          </pre>
        </Panel>
      </div>

      <Panel title="repository events">
        <EventLog events={r.emitter.events} height="h-40" />
      </Panel>
    </div>
  );
}
