// Mini query engine: SQL subset → AST → logical plan → optimizer (predicate pushdown,
// index selection, cost-based join choice) → vectorized, batch-at-a-time execution over columnar tables.
import { now, rng } from "../shared.ts";

export type Value = number | string | null;

// ---------------- storage ----------------
export class Table {
  name: string;
  columns: string[];
  data: Record<string, Value[]>;
  rows: number;
  indexes = new Map<string, Map<Value, number[]>>(); // hash indexes
  distinct = new Map<string, number>();

  constructor(name: string, columns: string[], data: Record<string, Value[]>) {
    this.name = name;
    this.columns = columns;
    this.data = data;
    this.rows = data[columns[0]].length;
    for (const c of columns) this.distinct.set(c, new Set(data[c]).size);
  }

  createIndex(col: string) {
    const idx = new Map<Value, number[]>();
    this.data[col].forEach((v, i) => {
      const l = idx.get(v);
      if (l) l.push(i);
      else idx.set(v, [i]);
    });
    this.indexes.set(col, idx);
  }
}

export function sampleCatalog(users = 1000, orders = 5000, seed = 11): Map<string, Table> {
  const r = rng(seed);
  const countries = ["IN", "US", "DE", "BR", "JP", "NG", "FR", "CA"];
  const names = ["ana", "bo", "chen", "dev", "eli", "fatima", "gus", "hana", "ivan", "jo"];
  const statuses = ["paid", "shipped", "refunded", "pending"];
  const u = new Table("users", ["id", "name", "country", "age"], {
    id: Array.from({ length: users }, (_, i) => i + 1),
    name: Array.from({ length: users }, (_, i) => `${names[i % names.length]}${i + 1}`),
    country: Array.from({ length: users }, () => countries[Math.floor(r() * countries.length)]),
    age: Array.from({ length: users }, () => 18 + Math.floor(r() * 60)),
  });
  const o = new Table("orders", ["id", "user_id", "amount", "status"], {
    id: Array.from({ length: orders }, (_, i) => i + 1),
    user_id: Array.from({ length: orders }, () => 1 + Math.floor(r() * users)),
    amount: Array.from({ length: orders }, () => 5 + Math.floor(r() * 495)),
    status: Array.from({ length: orders }, () => statuses[Math.floor(r() * statuses.length)]),
  });
  u.createIndex("id");
  o.createIndex("id");
  o.createIndex("user_id");
  return new Map([["users", u], ["orders", o]]);
}

// ---------------- SQL parser ----------------
export type Expr =
  | { k: "col"; table?: string; name: string; key?: string }
  | { k: "num"; v: number }
  | { k: "str"; v: string }
  | { k: "bin"; op: string; l: Expr; r: Expr }
  | { k: "not"; e: Expr }
  | { k: "agg"; fn: string; arg: Expr | null; key?: string };
export type Select = {
  items: { expr: Expr; alias?: string }[];
  star: boolean;
  from: { table: string; alias: string };
  join?: { table: string; alias: string; on: Expr };
  where?: Expr;
  groupBy: Expr[];
  orderBy: { expr: Expr; desc: boolean }[];
  limit?: number;
};

const KW = new Set(["SELECT", "FROM", "WHERE", "JOIN", "INNER", "ON", "GROUP", "BY", "ORDER", "ASC", "DESC", "LIMIT", "AND", "OR", "NOT", "AS"]);
const AGGS = new Set(["COUNT", "SUM", "AVG", "MIN", "MAX"]);

export function parseSQL(sql: string): Select {
  const toks: { t: string; v: string }[] = [];
  const re = /\s*(?:(\d+(?:\.\d+)?)|'((?:[^']|'')*)'|([A-Za-z_][A-Za-z0-9_]*)|(<=|>=|<>|!=|[=<>(),.*+\-/;]))/y;
  let m: RegExpExecArray | null;
  let pos = 0;
  while (pos < sql.length) {
    if (/^\s*$/.test(sql.slice(pos))) break;
    re.lastIndex = pos;
    m = re.exec(sql);
    if (!m) throw new Error(`syntax error near '${sql.slice(pos, pos + 12).trim()}'`);
    pos = re.lastIndex;
    if (m[1] !== undefined) toks.push({ t: "num", v: m[1] });
    else if (m[2] !== undefined) toks.push({ t: "str", v: m[2].replace(/''/g, "'") });
    else if (m[3] !== undefined) toks.push(KW.has(m[3].toUpperCase()) || AGGS.has(m[3].toUpperCase()) ? { t: "kw", v: m[3].toUpperCase() } : { t: "id", v: m[3] });
    else if (m[4] !== ";") toks.push({ t: "op", v: m[4] });
  }
  let p = 0;
  const peek = () => toks[p];
  const is = (v: string) => toks[p] && (toks[p].t === "kw" || toks[p].t === "op") && toks[p].v === v;
  const eat = (v: string) => { if (!is(v)) throw new Error(`expected ${v} but found '${toks[p]?.v ?? "end of query"}'`); p++; };
  const id = () => { const t = toks[p]; if (t?.t !== "id") throw new Error(`expected identifier, found '${t?.v ?? "end"}'`); p++; return t.v; };

  const primary = (): Expr => {
    const t = peek();
    if (!t) throw new Error("unexpected end of query");
    if (t.t === "num") return p++, { k: "num", v: Number(t.v) };
    if (t.t === "str") return p++, { k: "str", v: t.v };
    if (t.t === "kw" && AGGS.has(t.v)) {
      p++; eat("(");
      let arg: Expr | null = null;
      if (is("*")) { if (t.v !== "COUNT") throw new Error(`${t.v}(*) is not valid`); p++; } else arg = expr();
      eat(")");
      return { k: "agg", fn: t.v, arg };
    }
    if (is("(")) { p++; const e = expr(); eat(")"); return e; }
    if (is("NOT")) { p++; return { k: "not", e: cmp() }; }
    if (is("-")) { p++; return { k: "bin", op: "-", l: { k: "num", v: 0 }, r: primary() }; }
    const name = id();
    if (is(".")) { p++; return { k: "col", table: name, name: id() }; }
    return { k: "col", name };
  };
  const mul = (): Expr => { let l = primary(); while (is("*") || is("/")) { const op = toks[p++].v; l = { k: "bin", op, l, r: primary() }; } return l; };
  const add = (): Expr => { let l = mul(); while (is("+") || is("-")) { const op = toks[p++].v; l = { k: "bin", op, l, r: mul() }; } return l; };
  const cmp = (): Expr => { const l = add(); for (const op of ["=", "!=", "<>", "<=", ">=", "<", ">"]) if (is(op)) { p++; return { k: "bin", op: op === "<>" ? "!=" : op, l, r: add() }; } return l; };
  const and = (): Expr => { let l = cmp(); while (is("AND")) { p++; l = { k: "bin", op: "AND", l, r: cmp() }; } return l; };
  function expr(): Expr { let l = and(); while (is("OR")) { p++; l = { k: "bin", op: "OR", l, r: and() }; } return l; }

  eat("SELECT");
  const q: Select = { items: [], star: false, from: { table: "", alias: "" }, groupBy: [], orderBy: [] };
  if (is("*")) { p++; q.star = true; }
  else do {
    const e = expr();
    let alias: string | undefined;
    if (is("AS")) { p++; alias = id(); } else if (peek()?.t === "id") alias = id();
    q.items.push({ expr: e, alias });
  } while (is(",") && ++p);
  eat("FROM");
  const tableRef = () => { const table = id(); let alias = table; if (is("AS")) { p++; alias = id(); } else if (peek()?.t === "id") alias = id(); return { table, alias }; };
  q.from = tableRef();
  if (is("INNER")) p++;
  if (is("JOIN")) { p++; const t = tableRef(); eat("ON"); q.join = { ...t, on: expr() }; }
  if (is("WHERE")) { p++; q.where = expr(); }
  if (is("GROUP")) { p++; eat("BY"); do q.groupBy.push(expr()); while (is(",") && ++p); }
  if (is("ORDER")) { p++; eat("BY"); do { const e = expr(); let desc = false; if (is("DESC")) { p++; desc = true; } else if (is("ASC")) p++; q.orderBy.push({ expr: e, desc }); } while (is(",") && ++p); }
  if (is("LIMIT")) { p++; const t = toks[p++]; if (t?.t !== "num") throw new Error("LIMIT expects a number"); q.limit = Number(t.v); }
  if (p < toks.length) throw new Error(`unexpected '${toks[p].v}'`);
  return q;
}

export const show = (e: Expr): string => {
  switch (e.k) {
    case "col": return e.table ? `${e.table}.${e.name}` : e.name;
    case "num": return String(e.v);
    case "str": return `'${e.v}'`;
    case "not": return `NOT ${show(e.e)}`;
    case "agg": return `${e.fn}(${e.arg ? show(e.arg) : "*"})`;
    case "bin": return `${show(e.l)} ${e.op} ${show(e.r)}`;
  }
};

// ---------------- vectorized operators ----------------
type Batch = { cols: Map<string, Value[]>; len: number };
export type Stats = { rows: number; batches: number; ms: number };
export type PlanNode = { name: string; detail: string; est: number; cost: number; children: PlanNode[]; stats: Stats; op: Operator };

interface Operator { next(): Batch | null; columns: string[] }

function evalVec(e: Expr, b: Batch): Value[] {
  switch (e.k) {
    case "num": case "str": return new Array(b.len).fill(e.v);
    case "col": case "agg": { const c = b.cols.get(e.key!); if (!c) throw new Error(`column ${e.key} not available here`); return c; }
    case "not": return evalVec(e.e, b).map((v) => (v ? 0 : 1));
    case "bin": {
      const l = evalVec(e.l, b), r = evalVec(e.r, b), out = new Array<Value>(b.len);
      for (let i = 0; i < b.len; i++) {
        const x = l[i], y = r[i];
        switch (e.op) {
          case "+": out[i] = (x as number) + (y as number); break;
          case "-": out[i] = (x as number) - (y as number); break;
          case "*": out[i] = (x as number) * (y as number); break;
          case "/": out[i] = y === 0 ? null : (x as number) / (y as number); break;
          case "=": out[i] = x === y ? 1 : 0; break;
          case "!=": out[i] = x !== y ? 1 : 0; break;
          case "<": out[i] = x! < y! ? 1 : 0; break;
          case "<=": out[i] = x! <= y! ? 1 : 0; break;
          case ">": out[i] = x! > y! ? 1 : 0; break;
          case ">=": out[i] = x! >= y! ? 1 : 0; break;
          case "AND": out[i] = x && y ? 1 : 0; break;
          case "OR": out[i] = x || y ? 1 : 0; break;
        }
      }
      return out;
    }
  }
}

function select(b: Batch, mask: Value[]): Batch {
  const idx: number[] = [];
  for (let i = 0; i < b.len; i++) if (mask[i]) idx.push(i);
  const cols = new Map<string, Value[]>();
  for (const [k, v] of b.cols) cols.set(k, idx.map((i) => v[i]));
  return { cols, len: idx.length };
}

function drain(op: Operator): Batch {
  const cols = new Map<string, Value[]>(op.columns.map((c) => [c, []]));
  let len = 0;
  for (let b = op.next(); b; b = op.next()) {
    for (const [k, v] of b.cols) cols.get(k)!.push(...v);
    len += b.len;
  }
  return { cols, len };
}

function chunked(all: Batch, size: number): () => Batch | null {
  let off = 0;
  return () => {
    if (off >= all.len) return null;
    const cols = new Map<string, Value[]>();
    for (const [k, v] of all.cols) cols.set(k, v.slice(off, off + size));
    const len = Math.min(size, all.len - off);
    off += size;
    return { cols, len };
  };
}

function instrument(node: Omit<PlanNode, "stats" | "op">, make: (stats: Stats) => Operator): PlanNode {
  const stats: Stats = { rows: 0, batches: 0, ms: 0 };
  const inner = make(stats);
  const op: Operator = {
    columns: inner.columns,
    next() {
      const t = now();
      const b = inner.next();
      stats.ms += now() - t;
      if (b) { stats.rows += b.len; stats.batches++; }
      return b;
    },
  };
  return { ...node, stats, op };
}

// ---------------- planner ----------------
export type JoinStrategy = "auto" | "hash" | "sort-merge" | "nested-loop";
export type QueryOptions = { batchSize?: number; join?: JoinStrategy; pushdown?: boolean; useIndex?: boolean };

const conjuncts = (e?: Expr): Expr[] => (!e ? [] : e.k === "bin" && e.op === "AND" ? [...conjuncts(e.l), ...conjuncts(e.r)] : [e]);
const andAll = (es: Expr[]): Expr | undefined => es.reduce<Expr | undefined>((a, e) => (a ? { k: "bin", op: "AND", l: a, r: e } : e), undefined);
const hasAgg = (e: Expr): boolean => e.k === "agg" || (e.k === "bin" && (hasAgg(e.l) || hasAgg(e.r))) || (e.k === "not" && hasAgg(e.e));

export function plan(sql: string, catalog: Map<string, Table>, opts: QueryOptions = {}) {
  const { batchSize = 1024, join = "auto", pushdown = true, useIndex = true } = opts;
  const q = parseSQL(sql);
  const scopes = [q.from, ...(q.join ? [q.join] : [])];
  const tables = new Map<string, Table>();
  for (const s of scopes) {
    const t = catalog.get(s.table);
    if (!t) throw new Error(`table '${s.table}' does not exist (try: ${[...catalog.keys()].join(", ")})`);
    tables.set(s.alias, t);
  }

  // resolve column references to qualified keys "alias.col"
  const tablesOf = new Map<Expr, Set<string>>();
  const resolve = (e: Expr): Set<string> => {
    let s = new Set<string>();
    if (e.k === "col") {
      const owners = e.table ? [e.table] : [...tables.entries()].filter(([, t]) => t.columns.includes(e.name)).map(([a]) => a);
      if (owners.length === 0 || (e.table && !tables.get(e.table)?.columns.includes(e.name))) throw new Error(`unknown column '${show(e)}'`);
      if (owners.length > 1) throw new Error(`column '${e.name}' is ambiguous; qualify it (${owners.map((o) => `${o}.${e.name}`).join(" or ")})`);
      e.key = `${owners[0]}.${e.name}`;
      s.add(owners[0]);
    } else if (e.k === "bin") s = new Set([...resolve(e.l), ...resolve(e.r)]);
    else if (e.k === "not") s = resolve(e.e);
    else if (e.k === "agg") { if (e.arg) s = resolve(e.arg); e.key = show(e); }
    tablesOf.set(e, s);
    return s;
  };
  const items = q.star ? [...tables.entries()].flatMap(([a, t]) => t.columns.map((c) => ({ expr: { k: "col", table: a, name: c } as Expr, alias: undefined as string | undefined }))) : q.items;
  items.forEach((i) => resolve(i.expr));
  const where = conjuncts(q.where);
  where.forEach((w) => { if (hasAgg(w)) throw new Error("aggregates are not allowed in WHERE"); resolve(w); });
  q.groupBy.forEach(resolve);
  if (q.join) resolve(q.join.on);

  // selectivity estimates from per-column distinct counts
  const sel = (e: Expr): number => {
    if (e.k === "bin" && e.op === "=" ) { const c = [e.l, e.r].find((x) => x.k === "col") as Extract<Expr, { k: "col" }> | undefined; if (c) { const [a, col] = c.key!.split("."); return 1 / (tables.get(a)!.distinct.get(col) ?? 10); } return 0.1; }
    if (e.k === "bin" && ["<", "<=", ">", ">="].includes(e.op)) return 0.33;
    if (e.k === "bin" && e.op === "OR") return Math.min(1, sel(e.l) + sel(e.r));
    return 0.5;
  };

  const scanFor = (alias: string): PlanNode => {
    const t = tables.get(alias)!;
    const mine = pushdown ? where.filter((w) => { const s = tablesOf.get(w)!; return s.size === 1 && s.has(alias); }) : [];
    const cols = t.columns.map((c) => `${alias}.${c}`);
    // index selection: col = literal on an indexed column
    const idxPred = useIndex ? mine.find((w) => w.k === "bin" && w.op === "=" && ((w.l.k === "col" && t.indexes.has(w.l.name) && (w.r.k === "num" || w.r.k === "str")) || (w.r.k === "col" && t.indexes.has(w.r.name) && (w.l.k === "num" || w.l.k === "str")))) : undefined;
    const residual = andAll(mine.filter((w) => w !== idxPred));
    const est = Math.max(1, Math.round(t.rows * mine.reduce((s, w) => s * sel(w), 1)));
    if (idxPred && idxPred.k === "bin") {
      const [c, lit] = idxPred.l.k === "col" ? [idxPred.l, idxPred.r] : [idxPred.r, idxPred.l];
      const key = (lit as { v: Value }).v;
      const colName = (c as { name: string }).name;
      return instrument({ name: "IndexScan", detail: `${t.name} ${alias} USING hash(${colName}) = ${JSON.stringify(key)}${residual ? ` FILTER ${show(residual)}` : ""}`, est, cost: est + 1, children: [] }, () => {
        let done = false;
        return {
          columns: cols,
          next() {
            if (done) return null;
            done = true;
            const ids = t.indexes.get(colName)!.get(key) ?? [];
            let b: Batch = { cols: new Map(t.columns.map((col) => [`${alias}.${col}`, ids.map((i) => t.data[col][i])])), len: ids.length };
            if (residual) b = select(b, evalVec(residual, b));
            return b;
          },
        };
      });
    }
    return instrument({ name: "SeqScan", detail: `${t.name} ${alias}${residual ? ` FILTER ${show(residual)}` : ""}`, est, cost: t.rows, children: [] }, () => {
      let off = 0;
      return {
        columns: cols,
        next() {
          while (off < t.rows) {
            const len = Math.min(batchSize, t.rows - off);
            let b: Batch = { cols: new Map(t.columns.map((c) => [`${alias}.${c}`, t.data[c].slice(off, off + len)])), len };
            off += len;
            if (residual) b = select(b, evalVec(residual, b));
            if (b.len > 0) return b;
          }
          return null;
        },
      };
    });
  };

  let root = scanFor(q.from.alias);
  if (q.join) {
    const right = scanFor(q.join.alias);
    const on = q.join.on;
    const eq = on.k === "bin" && on.op === "=" && on.l.k === "col" && on.r.k === "col" && tablesOf.get(on.l)!.size === 1 && tablesOf.get(on.r)!.size === 1 && !tablesOf.get(on.l)!.has([...tablesOf.get(on.r)!][0]);
    const L = root.est, R = right.est;
    let lk = "", rk = "", distinctMax = Math.max(L, R);
    if (eq && on.k === "bin") {
      const a = on.l as { key: string }, b = on.r as { key: string };
      [lk, rk] = root.op.columns.includes(a.key) ? [a.key, b.key] : [b.key, a.key];
      const d = (k: string) => { const [al, c] = k.split("."); return tables.get(al)!.distinct.get(c) ?? 1; };
      distinctMax = Math.max(d(lk), d(rk));
    }
    const costs: Record<Exclude<JoinStrategy, "auto">, number> = {
      "nested-loop": L * R,
      hash: eq ? 1.2 * Math.min(L, R) + Math.max(L, R) : Infinity,
      "sort-merge": eq ? L * Math.log2(L + 1) + R * Math.log2(R + 1) + L + R : Infinity,
    };
    let strategy = join === "auto" ? (Object.entries(costs).sort((a, b) => a[1] - b[1])[0][0] as Exclude<JoinStrategy, "auto">) : join;
    if (!eq && strategy !== "nested-loop") strategy = "nested-loop";
    const est = Math.max(1, Math.round(eq ? (L * R) / distinctMax : L * R * 0.1));
    const left = root;
    const columns = [...left.op.columns, ...right.op.columns];
    const detail = `${strategy.toUpperCase()} ON ${show(on)}  · est costs: hash ${fmt(costs.hash)}, sort-merge ${fmt(costs["sort-merge"])}, nested ${fmt(costs["nested-loop"])}`;
    root = instrument({ name: "Join", detail, est, cost: costs[strategy] + left.cost + right.cost, children: [left, right] }, () => {
      let emit: (() => Batch | null) | null = null;
      const combine = (lb: Batch, li: number[], rb: Batch, ri: number[]): Batch => {
        const cols = new Map<string, Value[]>();
        for (const [k, v] of lb.cols) cols.set(k, li.map((i) => v[i]));
        for (const [k, v] of rb.cols) cols.set(k, ri.map((i) => v[i]));
        return { cols, len: li.length };
      };
      return {
        columns,
        next() {
          if (!emit) {
            if (strategy === "hash") {
              const build = drain(right.op); // build on right input
              const ht = new Map<Value, number[]>();
              build.cols.get(rk)!.forEach((v, i) => { const l = ht.get(v); if (l) l.push(i); else ht.set(v, [i]); });
              emit = () => {
                for (let lb = left.op.next(); lb; lb = left.op.next()) {
                  const li: number[] = [], ri: number[] = [];
                  lb.cols.get(lk)!.forEach((v, i) => { for (const j of ht.get(v) ?? []) { li.push(i); ri.push(j); } });
                  if (li.length) return combine(lb, li, build, ri);
                }
                return null;
              };
            } else if (strategy === "sort-merge") {
              const a = drain(left.op), b = drain(right.op);
              const ka = a.cols.get(lk)!, kb = b.cols.get(rk)!;
              const ia = [...ka.keys()].sort((x, y) => (ka[x]! < ka[y]! ? -1 : ka[x]! > ka[y]! ? 1 : 0));
              const ib = [...kb.keys()].sort((x, y) => (kb[x]! < kb[y]! ? -1 : kb[x]! > kb[y]! ? 1 : 0));
              const li: number[] = [], ri: number[] = [];
              let i = 0, j = 0;
              while (i < ia.length && j < ib.length) {
                const x = ka[ia[i]]!, y = kb[ib[j]]!;
                if (x < y) i++;
                else if (x > y) j++;
                else {
                  let j2 = j;
                  while (j2 < ib.length && kb[ib[j2]] === x) j2++;
                  for (; i < ia.length && ka[ia[i]] === x; i++) for (let jj = j; jj < j2; jj++) { li.push(ia[i]); ri.push(ib[jj]); }
                  j = j2;
                }
              }
              emit = chunked(combine(a, li, b, ri), batchSize);
            } else {
              const inner = drain(right.op);
              let pairs = 0;
              emit = () => {
                for (let lb = left.op.next(); lb; lb = left.op.next()) {
                  const li: number[] = [], ri: number[] = [];
                  // ponytail: browser safety cap; a real engine would spill or switch algorithm
                  if ((pairs += lb.len * inner.len) > 8_000_000) throw new Error(`nested-loop join exceeded 8M row comparisons — that's the point: try hash or sort-merge`);
                  for (let i = 0; i < lb.len; i++) {
                    const row = combine(lb, new Array(inner.len).fill(i), inner, [...Array(inner.len).keys()]);
                    evalVec(on, row).forEach((m, j) => { if (m) { li.push(i); ri.push(j); } });
                  }
                  if (li.length) return combine(lb, li, inner, ri);
                }
                return null;
              };
            }
          }
          return emit();
        },
      };
    });
  }

  const remaining = pushdown ? where.filter((w) => tablesOf.get(w)!.size !== 1) : where;
  if (remaining.length) {
    const f = andAll(remaining)!;
    const child = root;
    root = instrument({ name: "Filter", detail: show(f), est: Math.round(child.est * remaining.reduce((s, w) => s * sel(w), 1)), cost: child.cost + child.est, children: [child] }, () => ({
      columns: child.op.columns,
      next() { for (let b = child.op.next(); b; b = child.op.next()) { const s = select(b, evalVec(f, b)); if (s.len) return s; } return null; },
    }));
  }

  const aggs: Extract<Expr, { k: "agg" }>[] = [];
  const collectAggs = (e: Expr) => { if (e.k === "agg") { if (!aggs.some((a) => a.key === e.key)) aggs.push(e); } else if (e.k === "bin") { collectAggs(e.l); collectAggs(e.r); } else if (e.k === "not") collectAggs(e.e); };
  items.forEach((i) => collectAggs(i.expr));
  q.orderBy.forEach((o) => { if (hasAgg(o.expr)) { resolve(o.expr); collectAggs(o.expr); } });
  if (aggs.length || q.groupBy.length) {
    const keys = q.groupBy.map((g) => { if (g.k !== "col") throw new Error("GROUP BY supports column references only"); return g.key!; });
    for (const i of items) {
      const bad = (e: Expr): boolean => (e.k === "col" ? !keys.includes(e.key!) : e.k === "bin" ? bad(e.l) || bad(e.r) : e.k === "not" ? bad(e.e) : false);
      if (bad(i.expr)) throw new Error(`'${show(i.expr)}' must appear in GROUP BY or be inside an aggregate`);
    }
    const child = root;
    const est = keys.length ? Math.min(child.est, keys.reduce((s, k) => { const [a, c] = k.split("."); return s * (tables.get(a)!.distinct.get(c) ?? 10); }, 1)) : 1;
    root = instrument({ name: "HashAggregate", detail: `${keys.length ? `GROUP BY ${keys.join(", ")} ` : ""}→ ${aggs.map(show).join(", ")}`, est, cost: child.cost + child.est, children: [child] }, () => {
      let done = false;
      return {
        columns: [...keys, ...aggs.map((a) => a.key!)],
        next() {
          if (done) return null;
          done = true;
          const groups = new Map<string, { keys: Value[]; st: { n: number; sum: number; min: Value; max: Value }[] }>();
          for (let b = child.op.next(); b; b = child.op.next()) {
            const kv = keys.map((k) => b.cols.get(k)!);
            const av = aggs.map((a) => (a.arg ? evalVec(a.arg, b) : null));
            for (let i = 0; i < b.len; i++) {
              const gk = kv.map((c) => c[i]);
              const id = JSON.stringify(gk);
              let g = groups.get(id);
              if (!g) groups.set(id, (g = { keys: gk, st: aggs.map(() => ({ n: 0, sum: 0, min: null, max: null })) }));
              aggs.forEach((_, j) => {
                const v = av[j] ? av[j]![i] : 1;
                if (v === null) return;
                const s = g!.st[j];
                s.n++;
                if (typeof v === "number") s.sum += v;
                if (s.min === null || v < s.min) s.min = v;
                if (s.max === null || v > s.max) s.max = v;
              });
            }
          }
          if (groups.size === 0 && keys.length === 0) groups.set("[]", { keys: [], st: aggs.map(() => ({ n: 0, sum: 0, min: null, max: null })) });
          const gs = [...groups.values()];
          const cols = new Map<string, Value[]>();
          keys.forEach((k, j) => cols.set(k, gs.map((g) => g.keys[j])));
          aggs.forEach((a, j) => cols.set(a.key!, gs.map((g) => { const s = g.st[j]; return a.fn === "COUNT" ? s.n : a.fn === "SUM" ? s.sum : a.fn === "AVG" ? (s.n ? Math.round((s.sum / s.n) * 100) / 100 : null) : a.fn === "MIN" ? s.min : s.max; })));
          return { cols, len: gs.length };
        },
      };
    });
  }

  // projection (ORDER BY may reference output names or input columns kept alongside)
  const outNames = items.map((i) => i.alias ?? show(i.expr));
  const orderKeys = q.orderBy.map((o) => {
    const byName = outNames.indexOf(o.expr.k === "col" && !o.expr.table ? o.expr.name : show(o.expr));
    if (byName >= 0) return { col: outNames[byName], expr: null as Expr | null, desc: o.desc };
    if (!hasAgg(o.expr)) resolve(o.expr);
    return { col: `__order_${show(o.expr)}`, expr: o.expr, desc: o.desc };
  });
  {
    const child = root;
    root = instrument({ name: "Project", detail: outNames.join(", "), est: child.est, cost: child.cost, children: [child] }, () => ({
      columns: [...outNames, ...orderKeys.filter((k) => k.expr).map((k) => k.col)],
      next() {
        const b = child.op.next();
        if (!b) return null;
        const cols = new Map<string, Value[]>();
        items.forEach((it, j) => cols.set(outNames[j], evalVec(it.expr, b)));
        orderKeys.forEach((k) => { if (k.expr) cols.set(k.col, evalVec(k.expr, b)); });
        return { cols, len: b.len };
      },
    }));
  }
  if (orderKeys.length) {
    const child = root;
    root = instrument({ name: "Sort", detail: q.orderBy.map((o) => `${show(o.expr)} ${o.desc ? "DESC" : "ASC"}`).join(", "), est: child.est, cost: child.cost + child.est * Math.log2(child.est + 1), children: [child] }, () => {
      let emit: (() => Batch | null) | null = null;
      return {
        columns: child.op.columns,
        next() {
          if (!emit) {
            const all = drain(child.op);
            const idx = [...Array(all.len).keys()].sort((a, b) => {
              for (const k of orderKeys) {
                const c = all.cols.get(k.col)!;
                if (c[a] === c[b]) continue;
                const r = c[a]! < c[b]! ? -1 : 1;
                return k.desc ? -r : r;
              }
              return 0;
            });
            const cols = new Map<string, Value[]>();
            for (const [k, v] of all.cols) cols.set(k, idx.map((i) => v[i]));
            emit = chunked({ cols, len: all.len }, batchSize);
          }
          return emit();
        },
      };
    });
  }
  if (q.limit !== undefined) {
    const child = root, n = q.limit;
    root = instrument({ name: "Limit", detail: String(n), est: Math.min(n, child.est), cost: child.cost, children: [child] }, () => {
      let seen = 0;
      return {
        columns: child.op.columns,
        next() {
          if (seen >= n) return null;
          const b = child.op.next();
          if (!b) return null;
          const take = Math.min(b.len, n - seen);
          seen += take;
          const cols = new Map<string, Value[]>();
          for (const [k, v] of b.cols) cols.set(k, v.slice(0, take));
          return { cols, len: take };
        },
      };
    });
  }
  return { root, columns: outNames };
}

const fmt = (n: number) => (n === Infinity ? "n/a" : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : n.toFixed(0));

export function execute(sql: string, catalog: Map<string, Table>, opts: QueryOptions = {}) {
  const t0 = now();
  const { root, columns } = plan(sql, catalog, opts);
  const out = drain(root.op);
  const ms = now() - t0;
  const rows = [...Array(out.len).keys()].map((i) => columns.map((c) => out.cols.get(c)![i]));
  return { columns, rows, plan: root, ms };
}

export function explain(node: PlanNode, depth = 0): string {
  const line = `${"  ".repeat(depth)}${depth ? "└─ " : ""}${node.name} ${node.detail}  (est ${node.est} rows, actual ${node.stats.rows}, ${node.stats.batches} batches)`;
  return [line, ...node.children.map((c) => explain(c, depth + 1))].join("\n");
}

export const SAMPLE_QUERIES = [
  "SELECT country, COUNT(*) AS users, AVG(age) AS avg_age FROM users GROUP BY country ORDER BY users DESC",
  "SELECT u.name, SUM(o.amount) AS spent FROM users u JOIN orders o ON u.id = o.user_id WHERE o.status = 'paid' GROUP BY u.name ORDER BY spent DESC LIMIT 5",
  "SELECT * FROM orders WHERE id = 42",
  "SELECT status, COUNT(*), MIN(amount), MAX(amount) FROM orders WHERE amount > 400 GROUP BY status",
  "SELECT u.country, COUNT(*) AS orders FROM orders o JOIN users u ON o.user_id = u.id WHERE u.age < 30 AND o.amount >= 100 GROUP BY u.country ORDER BY orders DESC",
];
