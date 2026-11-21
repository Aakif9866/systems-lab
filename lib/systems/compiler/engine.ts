// "Tern": a tiny statically typed language.
// Pipeline: lexer → recursive-descent/Pratt parser → AST → type checker → AST optimizer
// (constant folding, dead-code elimination) → bytecode compiler → stack VM with mark-sweep GC.
//
// Language: int, bool, [int] arrays; let, if/else, while, return, print(); top-level fn declarations.
// Simplification (documented): functions see only their params and locals (no globals, no closures).

export type Phase = "lex" | "parse" | "type" | "runtime";
export class TernError extends Error {
  phase: Phase;
  line: number;
  col: number;
  constructor(phase: Phase, msg: string, line = 0, col = 0) {
    super(msg);
    this.phase = phase;
    this.line = line;
    this.col = col;
  }
}

// ---------------- lexer ----------------
export type TokKind = "int" | "ident" | "kw" | "op" | "eof";
export type Token = { kind: TokKind; text: string; line: number; col: number };
const KEYWORDS = new Set(["fn", "let", "if", "else", "while", "return", "print", "true", "false", "int", "bool"]);
const OPS = ["==", "!=", "<=", ">=", "&&", "||", "+", "-", "*", "/", "%", "<", ">", "=", "!", "(", ")", "{", "}", "[", "]", ",", ";", ":"];

export function lex(src: string): Token[] {
  const out: Token[] = [];
  let i = 0, line = 1, col = 1;
  const adv = (n: number) => { for (let k = 0; k < n; k++) { if (src[i] === "\n") { line++; col = 1; } else col++; i++; } };
  while (i < src.length) {
    const c = src[i];
    if (c === " " || c === "\t" || c === "\r" || c === "\n") { adv(1); continue; }
    if (c === "/" && src[i + 1] === "/") { while (i < src.length && src[i] !== "\n") adv(1); continue; }
    if (/[0-9]/.test(c)) {
      let j = i; while (j < src.length && /[0-9]/.test(src[j])) j++;
      out.push({ kind: "int", text: src.slice(i, j), line, col }); adv(j - i); continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i; while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j++;
      const text = src.slice(i, j);
      out.push({ kind: KEYWORDS.has(text) ? "kw" : "ident", text, line, col }); adv(j - i); continue;
    }
    const op = OPS.find((o) => src.startsWith(o, i));
    if (!op) throw new TernError("lex", `unexpected character '${c}'`, line, col);
    out.push({ kind: "op", text: op, line, col }); adv(op.length);
  }
  out.push({ kind: "eof", text: "<eof>", line, col });
  return out;
}

// ---------------- AST ----------------
export type Type = "int" | "bool" | "[int]" | "void";
type Pos = { line: number; col: number };
export type Expr =
  | ({ k: "num"; v: number } & Pos)
  | ({ k: "bool"; v: boolean } & Pos)
  | ({ k: "var"; name: string } & Pos)
  | ({ k: "bin"; op: string; l: Expr; r: Expr } & Pos)
  | ({ k: "un"; op: string; e: Expr } & Pos)
  | ({ k: "call"; name: string; args: Expr[] } & Pos)
  | ({ k: "arr"; items: Expr[] } & Pos)
  | ({ k: "idx"; arr: Expr; i: Expr } & Pos);
export type Stmt =
  | ({ k: "let"; name: string; ann?: Type; init: Expr } & Pos)
  | ({ k: "assign"; name: string; v: Expr } & Pos)
  | ({ k: "setidx"; arr: Expr; i: Expr; v: Expr } & Pos)
  | ({ k: "if"; cond: Expr; then: Stmt[]; els?: Stmt[] } & Pos)
  | ({ k: "while"; cond: Expr; body: Stmt[] } & Pos)
  | ({ k: "ret"; v?: Expr } & Pos)
  | ({ k: "print"; v: Expr } & Pos)
  | ({ k: "expr"; e: Expr } & Pos)
  | ({ k: "block"; body: Stmt[] } & Pos);
export type FnDecl = { name: string; params: { name: string; type: Type }[]; ret: Type; body: Stmt[] } & Pos;
export type Program = { fns: FnDecl[]; main: Stmt[] };

// ---------------- parser ----------------
const PREC: Record<string, number> = { "||": 1, "&&": 2, "==": 3, "!=": 3, "<": 4, "<=": 4, ">": 4, ">=": 4, "+": 5, "-": 5, "*": 6, "/": 6, "%": 6 };

export function parse(tokens: Token[]): Program {
  let p = 0;
  const peek = () => tokens[p];
  const at = (text: string) => tokens[p].text === text && tokens[p].kind !== "int" && tokens[p].kind !== "ident";
  const err = (msg: string, t = peek()): never => { throw new TernError("parse", msg, t.line, t.col); };
  const expect = (text: string) => (at(text) ? tokens[p++] : err(`expected '${text}' but found '${peek().text}'`));
  const ident = () => (peek().kind === "ident" ? tokens[p++] : err(`expected identifier, found '${peek().text}'`));

  const type = (): Type => {
    if (at("int")) return p++, "int";
    if (at("bool")) return p++, "bool";
    if (at("[")) { p++; expect("int"); expect("]"); return "[int]"; }
    return err(`expected a type (int, bool, [int]), found '${peek().text}'`);
  };

  const primary = (): Expr => {
    const t = peek();
    if (t.kind === "int") { p++; return { k: "num", v: Number(t.text), line: t.line, col: t.col }; }
    if (at("true") || at("false")) { p++; return { k: "bool", v: t.text === "true", line: t.line, col: t.col }; }
    if (t.kind === "ident") {
      p++;
      if (at("(")) {
        p++;
        const args: Expr[] = [];
        if (!at(")")) do args.push(expr(0)); while (at(",") && ++p);
        expect(")");
        return { k: "call", name: t.text, args, line: t.line, col: t.col };
      }
      return { k: "var", name: t.text, line: t.line, col: t.col };
    }
    if (at("(")) { p++; const e = expr(0); expect(")"); return e; }
    if (at("[")) {
      p++;
      const items: Expr[] = [];
      if (!at("]")) do items.push(expr(0)); while (at(",") && ++p);
      expect("]");
      return { k: "arr", items, line: t.line, col: t.col };
    }
    return err(`unexpected '${t.text}' in expression`);
  };

  const postfix = (): Expr => {
    let e = primary();
    while (at("[")) { const t = tokens[p++]; const i = expr(0); expect("]"); e = { k: "idx", arr: e, i, line: t.line, col: t.col }; }
    return e;
  };

  const unary = (): Expr => {
    if (at("-") || at("!")) { const t = tokens[p++]; return { k: "un", op: t.text, e: unary(), line: t.line, col: t.col }; }
    return postfix();
  };

  // Pratt / precedence climbing
  function expr(minPrec: number): Expr {
    let left = unary();
    while (peek().kind === "op" && PREC[peek().text] !== undefined && PREC[peek().text] > minPrec) {
      const t = tokens[p++];
      const right = expr(PREC[t.text]);
      left = { k: "bin", op: t.text, l: left, r: right, line: t.line, col: t.col };
    }
    return left;
  }

  const block = (): Stmt[] => { expect("{"); const body: Stmt[] = []; while (!at("}")) { if (peek().kind === "eof") err("unclosed block"); body.push(stmt()); } p++; return body; };

  function stmt(): Stmt {
    const t = peek();
    const pos = { line: t.line, col: t.col };
    if (at("let")) {
      p++; const name = ident().text; let ann: Type | undefined;
      if (at(":")) { p++; ann = type(); }
      expect("="); const init = expr(0); expect(";");
      return { k: "let", name, ann, init, ...pos };
    }
    if (at("if")) {
      p++; const cond = expr(0); const then = block(); let els: Stmt[] | undefined;
      if (at("else")) { p++; els = at("if") ? [stmt()] : block(); }
      return { k: "if", cond, then, els, ...pos };
    }
    if (at("while")) { p++; const cond = expr(0); return { k: "while", cond, body: block(), ...pos }; }
    if (at("return")) { p++; const v = at(";") ? undefined : expr(0); expect(";"); return { k: "ret", v, ...pos }; }
    if (at("print")) { p++; expect("("); const v = expr(0); expect(")"); expect(";"); return { k: "print", v, ...pos }; }
    if (at("{")) return { k: "block", body: block(), ...pos };
    const e = expr(0);
    if (at("=")) {
      p++; const v = expr(0); expect(";");
      if (e.k === "var") return { k: "assign", name: e.name, v, ...pos };
      if (e.k === "idx") return { k: "setidx", arr: e.arr, i: e.i, v, ...pos };
      return err("invalid assignment target", t);
    }
    expect(";");
    return { k: "expr", e, ...pos };
  }

  const prog: Program = { fns: [], main: [] };
  while (peek().kind !== "eof") {
    if (at("fn")) {
      const t = tokens[p++]; const name = ident().text; expect("(");
      const params: FnDecl["params"] = [];
      if (!at(")")) do { const pn = ident().text; expect(":"); params.push({ name: pn, type: type() }); } while (at(",") && ++p);
      expect(")");
      let ret: Type = "void";
      if (at(":")) { p++; ret = type(); }
      prog.fns.push({ name, params, ret, body: block(), line: t.line, col: t.col });
    } else prog.main.push(stmt());
  }
  return prog;
}

// ---------------- type checker ----------------
export function typecheck(prog: Program): TernError[] {
  const errors: TernError[] = [];
  const fail = (n: Pos, msg: string) => errors.push(new TernError("type", msg, n.line, n.col));
  const sigs = new Map<string, FnDecl>();
  for (const f of prog.fns) {
    if (sigs.has(f.name) || f.name === "len" || f.name === "push") fail(f, `function '${f.name}' is already defined`);
    sigs.set(f.name, f);
  }

  const check = (body: Stmt[], scopes: Map<string, Type>[], ret: Type) => {
    const lookup = (name: string) => { for (let i = scopes.length - 1; i >= 0; i--) { const t = scopes[i].get(name); if (t) return t; } };
    const ex = (e: Expr): Type => {
      switch (e.k) {
        case "num": return "int";
        case "bool": return "bool";
        case "var": { const t = lookup(e.name); if (!t) { fail(e, `undefined variable '${e.name}'`); return "int"; } return t; }
        case "un": { const t = ex(e.e); const want = e.op === "-" ? "int" : "bool"; if (t !== want) fail(e, `operator '${e.op}' expects ${want}, got ${t}`); return want; }
        case "bin": {
          const l = ex(e.l), r = ex(e.r);
          if (["+", "-", "*", "/", "%"].includes(e.op)) { if (l !== "int" || r !== "int") fail(e, `'${e.op}' expects int operands, got ${l} and ${r}`); return "int"; }
          if (["<", "<=", ">", ">="].includes(e.op)) { if (l !== "int" || r !== "int") fail(e, `'${e.op}' expects int operands, got ${l} and ${r}`); return "bool"; }
          if (e.op === "==" || e.op === "!=") { if (l !== r || l === "[int]") fail(e, `cannot compare ${l} with ${r}`); return "bool"; }
          if (l !== "bool" || r !== "bool") fail(e, `'${e.op}' expects bool operands, got ${l} and ${r}`);
          return "bool";
        }
        case "arr": for (const it of e.items) { const t = ex(it); if (t !== "int") fail(it, `array elements must be int, got ${t}`); } return "[int]";
        case "idx": { if (ex(e.arr) !== "[int]") fail(e, "only arrays can be indexed"); if (ex(e.i) !== "int") fail(e.i, "array index must be int"); return "int"; }
        case "call": {
          if (e.name === "len") { if (e.args.length !== 1 || ex(e.args[0]) !== "[int]") fail(e, "len(xs: [int]) expects one array"); return "int"; }
          if (e.name === "push") { if (e.args.length !== 2 || ex(e.args[0]) !== "[int]" || ex(e.args[1]) !== "int") fail(e, "push(xs: [int], v: int)"); return "void"; }
          const f = sigs.get(e.name);
          if (!f) { fail(e, `undefined function '${e.name}'`); e.args.forEach(ex); return "int"; }
          if (f.params.length !== e.args.length) fail(e, `'${e.name}' expects ${f.params.length} argument(s), got ${e.args.length}`);
          e.args.forEach((a, i) => { const t = ex(a); if (f.params[i] && t !== f.params[i].type) fail(a, `argument ${i + 1} of '${e.name}' must be ${f.params[i].type}, got ${t}`); });
          return f.ret;
        }
      }
    };
    for (const s of body) {
      switch (s.k) {
        case "let": {
          const t = ex(s.init);
          if (t === "void") fail(s, `cannot assign a void value to '${s.name}'`);
          if (s.ann && s.ann !== t) fail(s, `'${s.name}' is declared ${s.ann} but initialised with ${t}`);
          if (scopes[scopes.length - 1].has(s.name)) fail(s, `'${s.name}' is already declared in this scope`);
          scopes[scopes.length - 1].set(s.name, s.ann ?? t);
          break;
        }
        case "assign": { const t = lookup(s.name); const v = ex(s.v); if (!t) fail(s, `undefined variable '${s.name}'`); else if (v !== t) fail(s, `cannot assign ${v} to '${s.name}' of type ${t}`); break; }
        case "setidx": if (ex(s.arr) !== "[int]") fail(s, "only arrays can be indexed"); if (ex(s.i) !== "int") fail(s, "index must be int"); if (ex(s.v) !== "int") fail(s, "array elements must be int"); break;
        case "if": if (ex(s.cond) !== "bool") fail(s.cond, "if condition must be bool"); check(s.then, [...scopes, new Map()], ret); if (s.els) check(s.els, [...scopes, new Map()], ret); break;
        case "while": if (ex(s.cond) !== "bool") fail(s.cond, "while condition must be bool"); check(s.body, [...scopes, new Map()], ret); break;
        case "ret": { const t = s.v ? ex(s.v) : "void"; if (t !== ret) fail(s, `return type mismatch: expected ${ret}, got ${t}`); break; }
        case "print": { const t = ex(s.v); if (t === "void") fail(s, "cannot print a void value"); break; }
        case "expr": ex(s.e); break;
        case "block": check(s.body, [...scopes, new Map()], ret); break;
      }
    }
  };
  const returns = (b: Stmt[]): boolean => b.some((s) => s.k === "ret" || (s.k === "if" && !!s.els && returns(s.then) && returns(s.els)) || (s.k === "block" && returns(s.body)));
  for (const f of prog.fns) {
    check(f.body, [new Map(f.params.map((p) => [p.name, p.type]))], f.ret);
    if (f.ret !== "void" && !returns(f.body)) fail(f, `function '${f.name}' may finish without returning ${f.ret}`);
  }
  check(prog.main, [new Map()], "void");
  return errors;
}

// ---------------- optimizer (AST level) ----------------
export function optimize(prog: Program): { prog: Program; folds: number; deadRemoved: number } {
  let folds = 0, deadRemoved = 0;
  const ex = (e: Expr): Expr => {
    switch (e.k) {
      case "un": {
        const x = ex(e.e);
        if (x.k === "num" && e.op === "-") return folds++, { ...x, v: -x.v };
        if (x.k === "bool" && e.op === "!") return folds++, { ...x, v: !x.v };
        return { ...e, e: x };
      }
      case "bin": {
        const l = ex(e.l), r = ex(e.r);
        if (l.k === "num" && r.k === "num") {
          const a = l.v, b = r.v, pos = { line: e.line, col: e.col };
          const arith: Record<string, () => number | null> = { "+": () => a + b, "-": () => a - b, "*": () => a * b, "/": () => (b === 0 ? null : Math.trunc(a / b)), "%": () => (b === 0 ? null : a % b) };
          if (arith[e.op]) { const v = arith[e.op](); if (v !== null) return folds++, { k: "num", v, ...pos }; }
          const cmp: Record<string, boolean> = { "<": a < b, "<=": a <= b, ">": a > b, ">=": a >= b, "==": a === b, "!=": a !== b };
          if (e.op in cmp) return folds++, { k: "bool", v: cmp[e.op], ...pos };
        }
        if (l.k === "bool" && r.k === "bool") {
          const cmp: Record<string, boolean> = { "&&": l.v && r.v, "||": l.v || r.v, "==": l.v === r.v, "!=": l.v !== r.v };
          if (e.op in cmp) return folds++, { k: "bool", v: cmp[e.op], line: e.line, col: e.col };
        }
        return { ...e, l, r };
      }
      case "call": return { ...e, args: e.args.map(ex) };
      case "arr": return { ...e, items: e.items.map(ex) };
      case "idx": return { ...e, arr: ex(e.arr), i: ex(e.i) };
      default: return e;
    }
  };
  const body = (b: Stmt[]): Stmt[] => {
    const out: Stmt[] = [];
    for (let i = 0; i < b.length; i++) {
      const s = b[i];
      switch (s.k) {
        case "let": out.push({ ...s, init: ex(s.init) }); break;
        case "assign": out.push({ ...s, v: ex(s.v) }); break;
        case "setidx": out.push({ ...s, arr: ex(s.arr), i: ex(s.i), v: ex(s.v) }); break;
        case "print": out.push({ ...s, v: ex(s.v) }); break;
        case "expr": out.push({ ...s, e: ex(s.e) }); break;
        case "ret": out.push({ ...s, v: s.v && ex(s.v) }); break;
        case "block": out.push({ ...s, body: body(s.body) }); break;
        case "while": { const c = ex(s.cond); if (c.k === "bool" && !c.v) { deadRemoved++; break; } out.push({ ...s, cond: c, body: body(s.body) }); break; }
        case "if": {
          const c = ex(s.cond);
          if (c.k === "bool") { deadRemoved++; const taken = c.v ? s.then : s.els; if (taken) out.push({ k: "block", body: body(taken), line: s.line, col: s.col }); break; }
          out.push({ ...s, cond: c, then: body(s.then), els: s.els && body(s.els) });
          break;
        }
      }
      if (s.k === "ret" && i < b.length - 1) { deadRemoved += b.length - 1 - i; break; } // unreachable after return
    }
    return out;
  };
  return { prog: { fns: prog.fns.map((f) => ({ ...f, body: body(f.body) })), main: body(prog.main) }, folds, deadRemoved };
}

// ---------------- bytecode ----------------
export type Op =
  | "CONST" | "LOAD" | "STORE" | "ADD" | "SUB" | "MUL" | "DIV" | "MOD" | "NEG" | "NOT"
  | "EQ" | "NE" | "LT" | "LE" | "GT" | "GE" | "JMP" | "JZ" | "JNZ" | "DUP" | "POP"
  | "CALL" | "RET" | "PRINT" | "ARR" | "IDX" | "SETIDX" | "LEN" | "PUSH" | "HALT";
export type Instr = { op: Op; a?: number | boolean; b?: number; line: number };
export type Chunk = { name: string; arity: number; locals: number; code: Instr[] };

const BINOP: Record<string, Op> = { "+": "ADD", "-": "SUB", "*": "MUL", "/": "DIV", "%": "MOD", "==": "EQ", "!=": "NE", "<": "LT", "<=": "LE", ">": "GT", ">=": "GE" };

export function compile(prog: Program): Chunk[] {
  const fnIndex = new Map(prog.fns.map((f, i) => [f.name, i + 1])); // 0 = main
  const compileFn = (name: string, params: string[], body: Stmt[]): Chunk => {
    const chunk: Chunk = { name, arity: params.length, locals: params.length, code: [] };
    const scopes: Map<string, number>[] = [new Map(params.map((p, i) => [p, i]))];
    const emit = (op: Op, line: number, a?: number | boolean, b?: number) => chunk.code.push({ op, a, b, line }) - 1;
    const slot = (n: string) => { for (let i = scopes.length - 1; i >= 0; i--) { const s = scopes[i].get(n); if (s !== undefined) return s; } throw new Error(`unresolved ${n}`); };
    const ex = (e: Expr) => {
      switch (e.k) {
        case "num": case "bool": emit("CONST", e.line, e.v); break;
        case "var": emit("LOAD", e.line, slot(e.name)); break;
        case "un": ex(e.e); emit(e.op === "-" ? "NEG" : "NOT", e.line); break;
        case "bin":
          if (e.op === "&&" || e.op === "||") {
            ex(e.l); emit("DUP", e.line);
            const j = emit(e.op === "&&" ? "JZ" : "JNZ", e.line, 0);
            emit("POP", e.line); ex(e.r);
            chunk.code[j].a = chunk.code.length;
          } else { ex(e.l); ex(e.r); emit(BINOP[e.op], e.line); }
          break;
        case "arr": e.items.forEach(ex); emit("ARR", e.line, e.items.length); break;
        case "idx": ex(e.arr); ex(e.i); emit("IDX", e.line); break;
        case "call":
          e.args.forEach(ex);
          if (e.name === "len") emit("LEN", e.line);
          else if (e.name === "push") emit("PUSH", e.line);
          else emit("CALL", e.line, fnIndex.get(e.name)!, e.args.length);
          break;
      }
    };
    const st = (body: Stmt[]) => {
      for (const s of body) {
        switch (s.k) {
          case "let": { ex(s.init); const n = chunk.locals++; scopes[scopes.length - 1].set(s.name, n); emit("STORE", s.line, n); break; }
          case "assign": ex(s.v); emit("STORE", s.line, slot(s.name)); break;
          case "setidx": ex(s.arr); ex(s.i); ex(s.v); emit("SETIDX", s.line); break;
          case "print": ex(s.v); emit("PRINT", s.line); break;
          case "expr": ex(s.e); emit("POP", s.line); break;
          case "ret": if (s.v) ex(s.v); else emit("CONST", s.line, 0); emit("RET", s.line); break;
          case "block": scopes.push(new Map()); st(s.body); scopes.pop(); break;
          case "if": {
            ex(s.cond); const jz = emit("JZ", s.line, 0);
            scopes.push(new Map()); st(s.then); scopes.pop();
            if (s.els) { const jmp = emit("JMP", s.line, 0); chunk.code[jz].a = chunk.code.length; scopes.push(new Map()); st(s.els); scopes.pop(); chunk.code[jmp].a = chunk.code.length; }
            else chunk.code[jz].a = chunk.code.length;
            break;
          }
          case "while": {
            const top = chunk.code.length; ex(s.cond); const jz = emit("JZ", s.line, 0);
            scopes.push(new Map()); st(s.body); scopes.pop();
            emit("JMP", s.line, top); chunk.code[jz].a = chunk.code.length;
            break;
          }
        }
      }
    };
    st(body);
    if (name === "main") emit("HALT", 0); else { emit("CONST", 0, 0); emit("RET", 0); }
    return chunk;
  };
  return [compileFn("main", [], prog.main), ...prog.fns.map((f) => compileFn(f.name, f.params.map((p) => p.name), f.body))];
}

// ---------------- VM + mark-sweep GC ----------------
type Ref = { ref: number };
export type Value = number | boolean | Ref;
const isRef = (v: Value): v is Ref => typeof v === "object";

export type TraceStep = { fn: string; ip: number; op: Op; arg?: number | boolean; stack: string[] };
export type VMOptions = { maxSteps?: number; gcThreshold?: number; traceLimit?: number; maxStack?: number };

export function run(chunks: Chunk[], opts: VMOptions = {}) {
  const { maxSteps = 2_000_000, gcThreshold = 64, traceLimit = 400, maxStack = 20_000 } = opts;
  const heap = new Map<number, { items: number[]; marked: boolean }>();
  let nextRef = 1, nextGC = gcThreshold;
  const gc = { collections: 0, freed: 0, peakLive: 0, allocated: 0 };
  const stack: Value[] = [];
  const frames: { c: Chunk; ip: number; base: number }[] = [];
  const output: string[] = [];
  const trace: TraceStep[] = [];
  let steps = 0;
  const show = (v: Value): string => (isRef(v) ? `[${heap.get(v.ref)?.items.join(", ")}]` : String(v));
  const rt = (msg: string, line: number): never => { throw new TernError("runtime", msg, line, 0); };

  const collect = () => {
    for (const v of stack) if (isRef(v)) { const o = heap.get(v.ref); if (o) o.marked = true; } // arrays hold ints only → no transitive marking
    let freed = 0;
    for (const [id, o] of heap) { if (o.marked) o.marked = false; else { heap.delete(id); freed++; } }
    gc.collections++; gc.freed += freed;
    nextGC = Math.max(gcThreshold, heap.size * 2);
  };
  const alloc = (items: number[]): Ref => {
    if (heap.size >= nextGC) collect();
    heap.set(nextRef, { items, marked: false });
    gc.allocated++; gc.peakLive = Math.max(gc.peakLive, heap.size);
    return { ref: nextRef++ };
  };
  const enter = (c: Chunk, argc: number) => {
    const base = stack.length - argc;
    for (let i = argc; i < c.locals; i++) stack.push(0);
    frames.push({ c, ip: 0, base });
  };

  const t0 = typeof performance !== "undefined" ? performance.now() : Date.now();
  enter(chunks[0], 0);
  // reserve main's locals lazily: compiler may grow locals; ensure capacity
  while (frames.length) {
    const f = frames[frames.length - 1];
    const ins = f.c.code[f.ip++];
    if (++steps > maxSteps) rt(`step limit of ${maxSteps} exceeded (infinite loop?)`, ins.line);
    if (stack.length > maxStack) rt("stack overflow", ins.line);
    if (trace.length < traceLimit) trace.push({ fn: f.c.name, ip: f.ip - 1, op: ins.op, arg: ins.a, stack: stack.slice(-4).map(show) });
    const pop = () => stack.pop()!;
    const popN = () => pop() as number;
    switch (ins.op) {
      case "CONST": stack.push(ins.a!); break;
      case "LOAD": stack.push(stack[f.base + (ins.a as number)]); break;
      case "STORE": { const v = pop(); const i = f.base + (ins.a as number); while (stack.length <= i) stack.push(0); stack[i] = v; break; }
      case "ADD": { const b = popN(); stack.push((popN() + b) | 0); break; }
      case "SUB": { const b = popN(); stack.push((popN() - b) | 0); break; }
      case "MUL": { const b = popN(); stack.push(Math.imul(popN(), b)); break; }
      case "DIV": { const b = popN(); if (b === 0) rt("division by zero", ins.line); stack.push(Math.trunc(popN() / b)); break; }
      case "MOD": { const b = popN(); if (b === 0) rt("modulo by zero", ins.line); stack.push(popN() % b); break; }
      case "NEG": stack.push(-popN() | 0); break;
      case "NOT": stack.push(!pop()); break;
      case "EQ": { const b = pop(); stack.push(pop() === b); break; }
      case "NE": { const b = pop(); stack.push(pop() !== b); break; }
      case "LT": { const b = popN(); stack.push(popN() < b); break; }
      case "LE": { const b = popN(); stack.push(popN() <= b); break; }
      case "GT": { const b = popN(); stack.push(popN() > b); break; }
      case "GE": { const b = popN(); stack.push(popN() >= b); break; }
      case "JMP": f.ip = ins.a as number; break;
      case "JZ": if (!pop()) f.ip = ins.a as number; break;
      case "JNZ": if (pop()) f.ip = ins.a as number; break;
      case "DUP": stack.push(stack[stack.length - 1]); break;
      case "POP": pop(); break;
      case "PRINT": output.push(show(pop())); break;
      case "ARR": { const n = ins.a as number; const items = stack.splice(stack.length - n, n) as number[]; stack.push(alloc(items)); break; }
      case "IDX": { const i = popN(); const r = pop() as Ref; const o = heap.get(r.ref)!; if (i < 0 || i >= o.items.length) rt(`index ${i} out of bounds (len ${o.items.length})`, ins.line); stack.push(o.items[i]); break; }
      case "SETIDX": { const v = popN(); const i = popN(); const r = pop() as Ref; const o = heap.get(r.ref)!; if (i < 0 || i >= o.items.length) rt(`index ${i} out of bounds (len ${o.items.length})`, ins.line); o.items[i] = v; break; }
      case "LEN": stack.push(heap.get((pop() as Ref).ref)!.items.length); break;
      case "PUSH": { const v = popN(); heap.get((pop() as Ref).ref)!.items.push(v); stack.push(0); break; }
      case "CALL": enter(chunks[ins.a as number], ins.b!); break;
      case "RET": { const v = pop(); stack.length = f.base; frames.pop(); stack.push(v); break; }
      case "HALT": frames.pop(); break;
    }
  }
  const ms = (typeof performance !== "undefined" ? performance.now() : Date.now()) - t0;
  return { output, steps, ms, trace, gc: { ...gc, liveAtExit: heap.size } };
}

/** Whole pipeline with per-phase artefacts for the playground. */
export function compileAndRun(src: string, opts: VMOptions & { optimize?: boolean } = {}) {
  const tokens = lex(src);
  const ast = parse(tokens);
  const typeErrors = typecheck(ast);
  if (typeErrors.length) return { tokens, ast, typeErrors, ok: false as const };
  const opt = opts.optimize === false ? { prog: ast, folds: 0, deadRemoved: 0 } : optimize(ast);
  const chunks = compile(opt.prog);
  const result = run(chunks, opts);
  return { tokens, ast, typeErrors, ok: true as const, chunks, optimized: opt, result, instructions: chunks.reduce((s, c) => s + c.code.length, 0) };
}

export const SAMPLE = `// Tern: a tiny typed language compiled to bytecode
fn fib(n: int): int {
  if n < 2 { return n; }
  return fib(n - 1) + fib(n - 2);
}

fn sum(xs: [int]): int {
  let total = 0;
  let i = 0;
  while i < len(xs) {
    total = total + xs[i];
    i = i + 1;
  }
  return total;
}

let squares = [];
let k = 0;
while k < 10 {
  push(squares, k * k);
  let garbage = [k, k, k]; // short-lived: reclaimed by the GC
  k = k + 1;
}
print(sum(squares));
print(fib(15));
print(2 * 3 + 4 * 5); // folded at compile time
`;
