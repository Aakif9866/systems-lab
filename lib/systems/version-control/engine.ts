// Mini Git-like VCS: content-addressed objects (git's exact blob hashing), trees, commits,
// index, branches, Myers diff and diff3-style three-way merge.
import { Emitter } from "../shared.ts";

// ---------- SHA-1 (FIPS 180-1), synchronous so the engine stays deterministic ----------
export function sha1(input: string): string {
  const msg = new TextEncoder().encode(input);
  const ml = msg.length;
  const withPad = ((ml + 9 + 63) >> 6) << 6;
  const bytes = new Uint8Array(withPad);
  bytes.set(msg);
  bytes[ml] = 0x80;
  const dv = new DataView(bytes.buffer);
  dv.setUint32(withPad - 4, (ml * 8) >>> 0);
  dv.setUint32(withPad - 8, Math.floor((ml * 8) / 2 ** 32));
  let h0 = 0x67452301, h1 = 0xefcdab89, h2 = 0x98badcfe, h3 = 0x10325476, h4 = 0xc3d2e1f0;
  const w = new Uint32Array(80);
  for (let off = 0; off < withPad; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4);
    for (let i = 16; i < 80; i++) {
      const x = w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16];
      w[i] = (x << 1) | (x >>> 31);
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4;
    for (let i = 0; i < 80; i++) {
      const [f, k] =
        i < 20 ? [(b & c) | (~b & d), 0x5a827999]
        : i < 40 ? [b ^ c ^ d, 0x6ed9eba1]
        : i < 60 ? [(b & c) | (b & d) | (c & d), 0x8f1bbcdc]
        : [b ^ c ^ d, 0xca62c1d6];
      const t = (((a << 5) | (a >>> 27)) + f + e + k + w[i]) >>> 0;
      e = d; d = c; c = (b << 30) | (b >>> 2); b = a; a = t;
    }
    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0; h4 = (h4 + e) >>> 0;
  }
  return [h0, h1, h2, h3, h4].map((h) => h.toString(16).padStart(8, "0")).join("");
}

// ---------- Myers O(ND) line diff ----------
export type DiffOp = { op: " " | "+" | "-"; line: string };

export function diffLines(a: string[], b: string[]): DiffOp[] {
  const n = a.length, m = b.length, max = n + m;
  const v = new Map<number, number>([[1, 0]]);
  const trace: Map<number, number>[] = [];
  outer: for (let d = 0; d <= max; d++) {
    trace.push(new Map(v));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && (v.get(k - 1) ?? -1) < (v.get(k + 1) ?? -1)) ? v.get(k + 1)! : v.get(k - 1)! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x++; y++; }
      v.set(k, x);
      if (x >= n && y >= m) break outer;
    }
  }
  // backtrack
  const ops: DiffOp[] = [];
  let x = n, y = m;
  for (let d = trace.length - 1; d >= 0 && (x > 0 || y > 0); d--) {
    const vd = trace[d];
    const k = x - y;
    const prevK = k === -d || (k !== d && (vd.get(k - 1) ?? -1) < (vd.get(k + 1) ?? -1)) ? k + 1 : k - 1;
    const prevX = vd.get(prevK) ?? 0;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) { ops.push({ op: " ", line: a[--x] }); y--; }
    if (d > 0) {
      if (x === prevX) ops.push({ op: "+", line: b[--y] });
      else ops.push({ op: "-", line: a[--x] });
    }
  }
  return ops.reverse();
}

const splitLines = (s: string) => (s === "" ? [] : s.replace(/\n$/, "").split("\n"));

type Hunk = { start: number; end: number; lines: string[] };

/** Turn a diff of base→other into replace-hunks over base line ranges. */
function hunks(base: string[], other: string[]): Hunk[] {
  const out: Hunk[] = [];
  let i = 0;
  let cur: Hunk | null = null;
  for (const d of diffLines(base, other)) {
    if (d.op === " ") {
      if (cur) { out.push(cur); cur = null; }
      i++;
    } else {
      cur ??= { start: i, end: i, lines: [] };
      if (d.op === "-") cur.end = ++i;
      else cur.lines.push(d.line);
    }
  }
  if (cur) out.push(cur);
  return out;
}

/** diff3-style merge. Returns merged text and whether conflicts were found. */
export function merge3(base: string, ours: string, theirs: string, labels = ["ours", "theirs"]) {
  const B = splitLines(base);
  const tagged = [
    ...hunks(B, splitLines(ours)).map((h) => ({ ...h, side: 0 })),
    ...hunks(B, splitLines(theirs)).map((h) => ({ ...h, side: 1 })),
  ].sort((a, b) => a.start - b.start || a.end - b.end);
  const out: string[] = [];
  let conflicts = 0;
  let pos = 0;
  let i = 0;
  while (i < tagged.length) {
    const group = [tagged[i]];
    let end = tagged[i].end;
    let j = i + 1;
    // Hunks share a region when they overlap, or when one is a pure insertion at the
    // boundary of the other (order would be ambiguous). Adjacent edits stay separate.
    const touches = (h: Hunk) =>
      h.start < end || (h.start === end && (h.start === h.end || group.some((g) => g.start === g.end && g.start === end)));
    while (j < tagged.length && touches(tagged[j])) {
      end = Math.max(end, tagged[j].end);
      group.push(tagged[j++]);
    }
    const start = group[0].start;
    out.push(...B.slice(pos, start));
    const side = (s: number) => {
      const hs = group.filter((g) => g.side === s);
      if (hs.length === 0) return null;
      const res: string[] = [];
      let p = start;
      for (const h of hs) { res.push(...B.slice(p, h.start), ...h.lines); p = h.end; }
      res.push(...B.slice(p, end));
      return res;
    };
    const o = side(0), t = side(1);
    if (o && t && o.join("\n") !== t.join("\n")) {
      conflicts++;
      out.push(`<<<<<<< ${labels[0]}`, ...o, "=======", ...t, `>>>>>>> ${labels[1]}`);
    } else {
      out.push(...(o ?? t)!);
    }
    pos = end;
    i = j;
  }
  out.push(...B.slice(pos));
  return { text: out.length ? out.join("\n") + "\n" : "", conflicts };
}

// ---------- repository ----------
export type ObjType = "blob" | "tree" | "commit";
export type GitObject = { type: ObjType; body: string };
export type Commit = { hash: string; tree: string; parents: string[]; message: string; time: number };

export class Repo {
  objects = new Map<string, GitObject>();
  refs = new Map<string, string>(); // branch -> commit
  head = "main"; // symbolic ref to branch
  index = new Map<string, string>(); // path -> blob hash
  work = new Map<string, string>(); // working directory
  mergeHead: string | null = null;
  emitter: Emitter;
  private clock = 0;

  constructor(emitter = new Emitter("version-control")) {
    this.emitter = emitter;
  }

  /** git object format: "<type> <len>\0<body>" hashed with SHA-1. */
  hashObject(type: ObjType, body: string, write = true): string {
    const len = new TextEncoder().encode(body).length;
    const hash = sha1(`${type} ${len}\0${body}`);
    if (write && !this.objects.has(hash)) {
      this.objects.set(hash, { type, body });
      this.emitter.emit("object_written", "odb", { hash, type, bytes: len });
    }
    return hash;
  }

  read(hash: string): GitObject {
    const o = this.objects.get(hash);
    if (!o) throw new Error(`fatal: bad object ${hash}`);
    return o;
  }

  headCommit(): string | undefined {
    return this.refs.get(this.head);
  }

  write(path: string, content: string) {
    this.work.set(path, content.endsWith("\n") || content === "" ? content : content + "\n");
  }

  rm(path: string) {
    this.work.delete(path);
    this.index.delete(path);
  }

  add(path: string) {
    const paths = path === "." ? [...new Set([...this.work.keys(), ...this.index.keys()])] : [path];
    for (const p of paths) {
      const c = this.work.get(p);
      if (c === undefined) {
        if (!this.index.delete(p) && path !== ".") throw new Error(`fatal: pathspec '${p}' did not match any files`);
        continue;
      }
      this.index.set(p, this.hashObject("blob", c));
      this.emitter.emit("staged", "index", { path: p });
    }
  }

  /** Build nested tree objects from the flat index (dirs become subtrees). */
  private writeTree(entries: [string, string][]): string {
    const files: string[] = [];
    const dirs = new Map<string, [string, string][]>();
    for (const [p, h] of entries) {
      const slash = p.indexOf("/");
      if (slash < 0) files.push(`100644 blob ${h}\t${p}`);
      else {
        const d = p.slice(0, slash);
        if (!dirs.has(d)) dirs.set(d, []);
        dirs.get(d)!.push([p.slice(slash + 1), h]);
      }
    }
    for (const [d, sub] of dirs) files.push(`040000 tree ${this.writeTree(sub)}\t${d}`);
    files.sort((a, b) => a.split("\t")[1].localeCompare(b.split("\t")[1]));
    return this.hashObject("tree", files.join("\n"));
  }

  flattenTree(tree: string, prefix = ""): Map<string, string> {
    const out = new Map<string, string>();
    const body = this.read(tree).body;
    if (!body) return out;
    for (const line of body.split("\n")) {
      const [meta, name] = line.split("\t");
      const [, type, hash] = meta.split(" ");
      if (type === "tree") for (const [p, h] of this.flattenTree(hash, `${prefix}${name}/`)) out.set(p, h);
      else out.set(prefix + name, hash);
    }
    return out;
  }

  parseCommit(hash: string): Commit {
    const { body } = this.read(hash);
    const [head, ...msg] = body.split("\n\n");
    const parents: string[] = [];
    let tree = "";
    let time = 0;
    for (const l of head.split("\n")) {
      if (l.startsWith("tree ")) tree = l.slice(5);
      if (l.startsWith("parent ")) parents.push(l.slice(7));
      if (l.startsWith("author ")) time = Number(l.split(" ").pop());
    }
    return { hash, tree, parents, message: msg.join("\n\n"), time };
  }

  commit(message: string): string {
    if (!message.trim()) throw new Error("aborting commit due to empty commit message");
    const conflicted = [...this.work.entries()].filter(([, c]) => c.includes("<<<<<<< ")).map(([p]) => p);
    if (conflicted.length) throw new Error(`unresolved conflicts in: ${conflicted.join(", ")}`);
    const tree = this.writeTree([...this.index.entries()]);
    const parent = this.headCommit();
    if (parent && !this.mergeHead && this.parseCommit(parent).tree === tree) throw new Error("nothing to commit, working tree clean");
    const parents = [parent, this.mergeHead].filter((p): p is string => !!p);
    const body = [`tree ${tree}`, ...parents.map((p) => `parent ${p}`), `author learner <learner@systems.lab> ${++this.clock}`, "", message].join("\n");
    const hash = this.hashObject("commit", body);
    this.refs.set(this.head, hash);
    this.mergeHead = null;
    this.emitter.emit("commit", this.head, { hash, parents, message });
    return hash;
  }

  branch(name: string) {
    if (!/^[\w.-]+$/.test(name)) throw new Error(`invalid branch name '${name}'`);
    if (this.refs.has(name)) throw new Error(`branch '${name}' already exists`);
    const c = this.headCommit();
    if (!c) throw new Error("not a valid object name: 'HEAD' (commit first)");
    this.refs.set(name, c);
    this.emitter.emit("branch_created", name, { at: c });
  }

  status() {
    const headTree = this.headCommit() ? this.flattenTree(this.parseCommit(this.headCommit()!).tree) : new Map<string, string>();
    const staged: string[] = [], unstaged: string[] = [], untracked: string[] = [];
    for (const p of new Set([...headTree.keys(), ...this.index.keys()])) if (headTree.get(p) !== this.index.get(p)) staged.push(p);
    for (const [p, c] of this.work) {
      if (!this.index.has(p)) untracked.push(p);
      else if (this.hashObject("blob", c, false) !== this.index.get(p)) unstaged.push(p);
    }
    for (const p of this.index.keys()) if (!this.work.has(p)) unstaged.push(p);
    return { branch: this.head, staged, unstaged, untracked, merging: !!this.mergeHead };
  }

  checkout(name: string) {
    const target = this.refs.get(name);
    if (!target) throw new Error(`pathspec '${name}' did not match any branch`);
    const s = this.status();
    if (s.staged.length || s.unstaged.length) throw new Error("your local changes would be overwritten; commit them first");
    for (const p of this.index.keys()) this.work.delete(p);
    this.index = this.flattenTree(this.parseCommit(target).tree);
    for (const [p, h] of this.index) this.work.set(p, this.read(h).body);
    this.head = name;
    this.emitter.emit("checkout", name, { commit: target });
  }

  ancestors(hash: string): Set<string> {
    const seen = new Set<string>();
    const stack = [hash];
    while (stack.length) {
      const h = stack.pop()!;
      if (seen.has(h)) continue;
      seen.add(h);
      stack.push(...this.parseCommit(h).parents);
    }
    return seen;
  }

  /** Lowest common ancestor by BFS from `b` over `a`'s ancestor set. */
  mergeBase(a: string, b: string): string | null {
    const anc = this.ancestors(a);
    const queue = [b];
    const seen = new Set<string>();
    while (queue.length) {
      const h = queue.shift()!;
      if (anc.has(h)) return h;
      if (seen.has(h)) continue;
      seen.add(h);
      queue.push(...this.parseCommit(h).parents);
    }
    return null;
  }

  merge(name: string): { result: "up-to-date" | "fast-forward" | "merged" | "conflict"; conflicts: string[] } {
    const ours = this.headCommit();
    const theirs = this.refs.get(name);
    if (!ours || !theirs) throw new Error(`merge: '${name}' - not something we can merge`);
    const base = this.mergeBase(ours, theirs);
    if (base === theirs) return { result: "up-to-date", conflicts: [] };
    if (base === ours) {
      this.refs.set(this.head, theirs);
      const tree = this.flattenTree(this.parseCommit(theirs).tree);
      this.index = tree;
      this.work = new Map([...tree].map(([p, h]) => [p, this.read(h).body]));
      this.emitter.emit("merge", this.head, { kind: "fast-forward", to: theirs });
      return { result: "fast-forward", conflicts: [] };
    }
    const tb = base ? this.flattenTree(this.parseCommit(base).tree) : new Map<string, string>();
    const to = this.flattenTree(this.parseCommit(ours).tree);
    const tt = this.flattenTree(this.parseCommit(theirs).tree);
    const body = (h?: string) => (h ? this.read(h).body : "");
    const conflicts: string[] = [];
    for (const p of new Set([...tb.keys(), ...to.keys(), ...tt.keys()])) {
      const [b, o, t] = [tb.get(p), to.get(p), tt.get(p)];
      if (o === t) continue;
      if (b === o) {
        // only theirs changed
        if (t === undefined) this.rm(p);
        else { this.work.set(p, body(t)); this.index.set(p, t); }
        continue;
      }
      if (b === t) continue; // only ours changed
      const m = merge3(body(b), body(o), body(t), ["HEAD", name]);
      this.work.set(p, m.text);
      if (m.conflicts) conflicts.push(p);
      else this.index.set(p, this.hashObject("blob", m.text));
    }
    this.mergeHead = theirs;
    if (conflicts.length) {
      this.emitter.emit("merge_conflict", this.head, { with: name, files: conflicts });
      return { result: "conflict", conflicts };
    }
    this.commit(`Merge branch '${name}' into ${this.head}`);
    return { result: "merged", conflicts: [] };
  }

  log(): Commit[] {
    const out: Commit[] = [];
    const heads = [...this.refs.values()];
    const seen = new Set<string>();
    const stack = [...heads];
    while (stack.length) {
      const h = stack.pop()!;
      if (seen.has(h)) continue;
      seen.add(h);
      const c = this.parseCommit(h);
      out.push(c);
      stack.push(...c.parents);
    }
    return out.sort((a, b) => b.time - a.time);
  }

  diff(path: string): DiffOp[] {
    const staged = this.index.get(path);
    return diffLines(splitLines(staged ? this.read(staged).body : ""), splitLines(this.work.get(path) ?? ""));
  }

  storage() {
    const by: Record<ObjType, { count: number; bytes: number }> = { blob: { count: 0, bytes: 0 }, tree: { count: 0, bytes: 0 }, commit: { count: 0, bytes: 0 } };
    for (const o of this.objects.values()) { by[o.type].count++; by[o.type].bytes += o.body.length; }
    return by;
  }

  /** Tiny command interpreter used by the playground terminal. */
  exec(line: string): string {
    const parts = line.match(/"[^"]*"|\S+/g)?.map((s) => s.replace(/^"|"$/g, "")) ?? [];
    if (parts[0] === "git") parts.shift();
    const [cmd, ...args] = parts;
    switch (cmd) {
      case "write": {
        const [p, ...rest] = args;
        if (!p) return "usage: write <path> <content...>";
        this.write(p, rest.join(" ").replace(/\\n/g, "\n"));
        return `wrote ${p}`;
      }
      case "cat":
        return this.work.get(args[0]) ?? `cat: ${args[0]}: No such file`;
      case "ls":
        return [...this.work.keys()].sort().join("\n") || "(empty)";
      case "rm":
        this.rm(args[0]);
        return `rm '${args[0]}'`;
      case "add":
        this.add(args[0] ?? ".");
        return "";
      case "commit": {
        const mi = args.indexOf("-m");
        const h = this.commit(mi >= 0 ? args.slice(mi + 1).join(" ") : args.join(" "));
        return `[${this.head} ${h.slice(0, 7)}] committed`;
      }
      case "status": {
        const s = this.status();
        return [`On branch ${s.branch}${s.merging ? " (merging)" : ""}`, ...s.staged.map((p) => `  staged:    ${p}`), ...s.unstaged.map((p) => `  modified:  ${p}`), ...s.untracked.map((p) => `  untracked: ${p}`)].join("\n");
      }
      case "branch":
        if (args[0]) return this.branch(args[0]), `created branch ${args[0]}`;
        return [...this.refs.keys()].map((b) => (b === this.head ? `* ${b}` : `  ${b}`)).join("\n");
      case "checkout":
      case "switch":
        if (args[0] === "-b") return this.branch(args[1]), this.checkout(args[1]), `Switched to a new branch '${args[1]}'`;
        return this.checkout(args[0]), `Switched to branch '${args[0]}'`;
      case "merge": {
        const r = this.merge(args[0]);
        return r.result === "conflict" ? `CONFLICT in ${r.conflicts.join(", ")}; fix, add, commit` : r.result;
      }
      case "log":
        return this.log().map((c) => `${c.hash.slice(0, 7)} ${c.parents.length > 1 ? "(merge) " : ""}${c.message}`).join("\n") || "no commits yet";
      case "diff":
        return this.diff(args[0]).map((d) => d.op + d.line).join("\n");
      case "cat-file": {
        const h = [...this.objects.keys()].find((k) => k.startsWith(args[0] ?? "-"));
        if (!h) return "fatal: not a valid object name";
        const o = this.read(h);
        return `${o.type} ${h}\n${o.body}`;
      }
      case "hash-object":
        return this.hashObject("blob", args.join(" "), false);
      default:
        return `unknown command '${cmd ?? ""}'. try: write, add, commit, status, branch, checkout, merge, log, diff, cat-file`;
    }
  }
}
