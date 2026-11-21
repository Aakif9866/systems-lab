import { test } from "node:test";
import assert from "node:assert/strict";
import { SAMPLE_QUERIES, execute, explain, parseSQL, sampleCatalog } from "./engine.ts";

const cat = sampleCatalog(300, 1500, 3);
const users = cat.get("users")!, orders = cat.get("orders")!;

test("parser handles the supported grammar and rejects junk", () => {
  const q = parseSQL("SELECT u.name AS n, COUNT(*) FROM users u JOIN orders o ON u.id = o.user_id WHERE NOT o.amount < 10 GROUP BY u.name ORDER BY n DESC LIMIT 3;");
  assert.equal(q.items.length, 2);
  assert.equal(q.join?.alias, "o");
  assert.equal(q.limit, 3);
  assert.throws(() => parseSQL("SELEC * FROM users"), /expected SELECT/);
  assert.throws(() => parseSQL("SELECT * FROM users WHERE"), /end of query/);
});

test("group-by count matches a hand-computed answer", () => {
  const r = execute("SELECT country, COUNT(*) AS n FROM users GROUP BY country ORDER BY country", cat);
  const expected = new Map<string, number>();
  users.data.country.forEach((c) => expected.set(c as string, (expected.get(c as string) ?? 0) + 1));
  assert.deepEqual(r.rows, [...expected.entries()].sort((a, b) => a[0].localeCompare(b[0])));
});

test("all three join algorithms return identical results", () => {
  const sql = "SELECT u.country, SUM(o.amount) AS total FROM users u JOIN orders o ON u.id = o.user_id WHERE o.status = 'paid' GROUP BY u.country ORDER BY u.country";
  const byStrategy = (["hash", "sort-merge", "nested-loop"] as const).map((join) => execute(sql, cat, { join }));
  assert.deepEqual(byStrategy[0].rows, byStrategy[1].rows);
  assert.deepEqual(byStrategy[0].rows, byStrategy[2].rows);
  // hand-computed
  const countryOf = new Map(users.data.id.map((id, i) => [id, users.data.country[i]]));
  const expected = new Map<string, number>();
  orders.data.status.forEach((s, i) => {
    if (s !== "paid") return;
    const c = countryOf.get(orders.data.user_id[i]) as string;
    expected.set(c, (expected.get(c) ?? 0) + (orders.data.amount[i] as number));
  });
  assert.deepEqual(byStrategy[0].rows, [...expected.entries()].sort((a, b) => a[0].localeCompare(b[0])));
});

test("optimizer: cost model picks hash join, pushes predicates down, uses the index", () => {
  const r = execute("SELECT u.name FROM users u JOIN orders o ON u.id = o.user_id WHERE o.amount > 450 AND u.age < 25", cat);
  const text = explain(r.plan);
  assert.match(text, /Join HASH/);
  assert.match(text, /SeqScan orders o FILTER o\.amount > 450/);
  assert.match(text, /SeqScan users u FILTER u\.age < 25/);
  assert.doesNotMatch(text, /^Filter/m, "no post-join filter needed");

  const idx = execute("SELECT * FROM orders WHERE id = 42", cat);
  assert.match(explain(idx.plan), /IndexScan orders o?.*hash\(id\) = 42/);
  assert.equal(idx.rows.length, 1);
  const noIdx = execute("SELECT * FROM orders WHERE id = 42", cat, { useIndex: false });
  assert.deepEqual(noIdx.rows, idx.rows);
});

test("pushdown off gives the same answer but scans more rows into the join", () => {
  const sql = "SELECT COUNT(*) FROM users u JOIN orders o ON u.id = o.user_id WHERE o.amount > 450";
  const on = execute(sql, cat), off = execute(sql, cat, { pushdown: false });
  assert.deepEqual(on.rows, off.rows);
  const joinIn = (p: typeof on.plan): number => (p.name === "Join" ? p.children.reduce((s, c) => s + c.stats.rows, 0) : joinIn(p.children[0]));
  assert.ok(joinIn(on.plan) < joinIn(off.plan));
});

test("vectorized execution respects batch size and limit", () => {
  const r = execute("SELECT id FROM orders LIMIT 10", cat, { batchSize: 64 });
  assert.deepEqual(r.rows.map((x) => x[0]), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  const all = execute("SELECT id FROM orders", cat, { batchSize: 64 });
  const scan = (p: typeof all.plan): typeof all.plan => (p.children.length ? scan(p.children[0]) : p);
  assert.equal(scan(all.plan).stats.batches, Math.ceil(1500 / 64));
});

test("semantic errors are clear", () => {
  assert.throws(() => execute("SELECT nope FROM users", cat), /unknown column/);
  assert.throws(() => execute("SELECT id FROM users u JOIN orders o ON u.id = o.user_id", cat), /ambiguous/);
  assert.throws(() => execute("SELECT name, COUNT(*) FROM users", cat), /GROUP BY/);
  assert.throws(() => execute("SELECT * FROM nothing", cat), /does not exist/);
});

test("every sample query runs", () => {
  for (const q of SAMPLE_QUERIES) assert.ok(execute(q, cat).rows.length > 0, q);
});
