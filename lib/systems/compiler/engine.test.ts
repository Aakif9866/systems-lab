import { test } from "node:test";
import assert from "node:assert/strict";
import { SAMPLE, TernError, compileAndRun, lex, parse } from "./engine.ts";

const runOk = (src: string, opts = {}) => {
  const r = compileAndRun(src, opts);
  if (!r.ok) throw new Error(r.typeErrors.map((e) => e.message).join("; "));
  return r;
};

test("sample program produces the right output", () => {
  const r = runOk(SAMPLE);
  assert.deepEqual(r.result.output, ["285", "610", "26"]);
});

test("lexer tracks positions and rejects bad characters", () => {
  const t = lex("let x = 1;\n  x");
  assert.equal(t[0].text, "let");
  assert.deepEqual([t[5].line, t[5].col], [2, 3]);
  assert.throws(() => lex("let x = 1;\n  x @"), (e: TernError) => e.phase === "lex" && e.line === 2 && e.col === 5);
});

test("parser respects precedence and reports syntax errors", () => {
  const r = runOk("print(1 + 2 * 3 - 4 / 2);\nprint(!(1 < 2) || 3 == 3 && true);");
  assert.deepEqual(r.result.output, ["5", "true"]);
  assert.throws(() => parse(lex("let = 3;")), (e: TernError) => e.phase === "parse");
});

test("type checker catches real errors with locations", () => {
  const r = compileAndRun("let x: int = true;\nfn f(a: int): bool { return a; }\nprint(f(1, 2));\nprint(y);");
  assert.equal(r.ok, false);
  const msgs = r.typeErrors.map((e) => `${e.line}: ${e.message}`);
  assert.ok(msgs.some((m) => m.startsWith("1:") && m.includes("declared int")));
  assert.ok(msgs.some((m) => m.includes("return type mismatch")));
  assert.ok(msgs.some((m) => m.includes("expects 1 argument")));
  assert.ok(msgs.some((m) => m.includes("undefined variable 'y'")));
  assert.equal(compileAndRun("fn g(a: int): int { if a > 0 { return 1; } }").ok, false, "missing return path");
});

test("constant folding and dead-code elimination shrink bytecode without changing output", () => {
  const src = "print(2 * 3 + 4 * 5);\nif 1 > 2 { print(99); } else { print(7); }\nwhile false { print(0); }";
  const on = runOk(src);
  const off = runOk(src, { optimize: false });
  assert.deepEqual(on.result.output, off.result.output);
  assert.deepEqual(on.result.output, ["26", "7"]);
  assert.ok(on.instructions < off.instructions, `${on.instructions} < ${off.instructions}`);
  assert.ok(on.optimized.folds >= 4);
});

test("short-circuit evaluation skips the right side", () => {
  // right side would divide by zero if evaluated
  const r = runOk("let z = 0;\nprint(false && 1 / z == 0);\nprint(true || 1 / z == 0);");
  assert.deepEqual(r.result.output, ["false", "true"]);
});

test("GC reclaims garbage arrays but keeps live ones", () => {
  const r = runOk("let keep = [1, 2, 3];\nlet i = 0;\nwhile i < 500 { let tmp = [i, i]; i = i + 1; }\nprint(keep[2]);", { gcThreshold: 16 });
  assert.deepEqual(r.result.output, ["3"]);
  assert.ok(r.result.gc.collections > 0);
  assert.ok(r.result.gc.freed > 400);
  assert.ok(r.result.gc.peakLive <= 40);
});

test("runtime errors and limits", () => {
  assert.throws(() => runOk("let xs = [1];\nprint(xs[5]);"), /out of bounds/);
  assert.throws(() => runOk("let z = 0;\nprint(10 / z);"), /division by zero/);
  assert.throws(() => runOk("while true { }", { maxSteps: 1000 }), /step limit/);
  assert.throws(() => runOk("fn f(n: int): int { return f(n + 1); }\nprint(f(0));"), /stack overflow/);
});
