import { test } from "node:test";
import assert from "node:assert/strict";
import { Repo, diffLines, merge3, sha1 } from "./engine.ts";

test("sha1 matches known vectors and git's blob hash", () => {
  assert.equal(sha1("abc"), "a9993e364706816aba3e25717850c26c9cd0d89d");
  assert.equal(sha1(""), "da39a3ee5e6b4b0d3255bfef95601890afd80709");
  // `printf hello | git hash-object --stdin`
  assert.equal(new Repo().hashObject("blob", "hello", false), "b6fc4c620b67d95f953a5c1c1230aaab5db5a1b0");
});

test("myers diff reconstructs both sides and is minimal on a classic case", () => {
  const a = "A B C A B B A".split(" ");
  const b = "C B A B A C".split(" ");
  const d = diffLines(a, b);
  assert.deepEqual(d.filter((x) => x.op !== "+").map((x) => x.line), a);
  assert.deepEqual(d.filter((x) => x.op !== "-").map((x) => x.line), b);
  assert.equal(d.filter((x) => x.op !== " ").length, 5); // D = 5 for this pair
});

test("merge3: non-overlapping edits merge cleanly, same-line edits conflict", () => {
  const base = "a\nb\nc\nd\n";
  const clean = merge3(base, "A\nb\nc\nd\n", "a\nb\nc\nD\n");
  assert.equal(clean.conflicts, 0);
  assert.equal(clean.text, "A\nb\nc\nD\n");
  const bad = merge3(base, "a\nX\nc\nd\n", "a\nY\nc\nd\n");
  assert.equal(bad.conflicts, 1);
  assert.match(bad.text, /<<<<<<< ours\nX\n=======\nY\n>>>>>>> theirs/);
  assert.equal(merge3(base, "a\nZ\nc\nd\n", "a\nZ\nc\nd\n").conflicts, 0, "identical changes don't conflict");
});

test("repo: identical content is stored once; commit, branch, fast-forward", () => {
  const r = new Repo();
  r.write("a.txt", "same");
  r.write("dir/b.txt", "same");
  r.add(".");
  r.commit("init");
  assert.equal(r.storage().blob.count, 1, "content-addressed dedup");
  assert.equal(r.storage().tree.count, 2, "root tree + dir subtree");
  r.branch("feat");
  r.checkout("feat");
  r.write("a.txt", "changed");
  r.add("a.txt");
  const c2 = r.commit("change a");
  r.checkout("main");
  assert.equal(r.work.get("a.txt"), "same\n");
  assert.equal(r.merge("feat").result, "fast-forward");
  assert.equal(r.headCommit(), c2);
  assert.equal(r.work.get("a.txt"), "changed\n");
});

test("repo: divergent branches produce a two-parent merge commit or a conflict", () => {
  const r = new Repo();
  r.write("f.txt", "1\n2\n3\n4\n5");
  r.add(".");
  r.commit("base");
  r.branch("x");
  r.write("f.txt", "ONE\n2\n3\n4\n5");
  r.add(".");
  r.commit("main edits line 1");
  r.checkout("x");
  r.write("f.txt", "1\n2\n3\n4\nFIVE");
  r.add(".");
  r.commit("x edits line 5");
  r.checkout("main");
  assert.equal(r.merge("x").result, "merged");
  assert.equal(r.work.get("f.txt"), "ONE\n2\n3\n4\nFIVE\n");
  assert.equal(r.parseCommit(r.headCommit()!).parents.length, 2);

  // now conflict
  r.checkout("x");
  r.write("f.txt", "1\nTWO-x\n3\n4\nFIVE");
  r.add(".");
  r.commit("x edits 2");
  r.checkout("main");
  r.write("f.txt", "ONE\nTWO-main\n3\n4\nFIVE");
  r.add(".");
  r.commit("main edits 2");
  const m = r.merge("x");
  assert.equal(m.result, "conflict");
  assert.throws(() => r.commit("try"), /unresolved conflicts/);
  r.write("f.txt", "ONE\nTWO\n3\n4\nFIVE");
  r.add(".");
  const mc = r.commit("resolve");
  assert.equal(r.parseCommit(mc).parents.length, 2);
});

test("exec interpreter drives the same engine", () => {
  const r = new Repo();
  r.exec('write readme.md "hello world"');
  r.exec("add .");
  assert.match(r.exec('commit -m "first"'), /\[main [0-9a-f]{7}\] committed/);
  assert.match(r.exec("log"), /first/);
  assert.throws(() => r.exec("checkout nope"), /did not match/);
});
