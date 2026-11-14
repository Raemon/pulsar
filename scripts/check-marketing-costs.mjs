import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { allocate, billingPeriods, capture, validateExpense } from "./marketing/costs.mjs";

test("imports each response once across forks, excludes unrelated work, allocates the subscription share once", async t => {
  const dir = await mkdtemp(join(tmpdir(), "pulsar-costs-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const turn = "00112233-4455-6677-8899-aabbccddeeff";
  const scope = { logs: [dir], turn, campaign: null };
  const context = id => ({ type: "turn_context", payload: { turn_id: id, root_turn_id: turn, model: "test" } });
  const response = id => ({ type: "token_usage_record", timestamp: "2026-01-01T00:00:00Z", payload: {
    root_turn_id: turn, thread_id: turn, turn_id: id, response_id: id, usage: {
      input_tokens: 100, cached_input_tokens: 60, output_tokens: 10, reasoning_output_tokens: 8,
    },
  } });
  const parent = [context("one"), response("one")];
  const other = response("elsewhere");
  other.payload.root_turn_id = "other-turn";
  const text = rows => rows.map(r => JSON.stringify(r)).join("\n") + "\n";
  await writeFile(join(dir, "rollout-parent.jsonl"), text([...parent, other]));
  await writeFile(join(dir, "rollout-child.jsonl"), text([...parent, context("two"), response("two")]));

  const { rows: unknown } = await capture(scope);
  assert.equal(unknown.length, 2);
  assert(unknown.every(row => row.basis === "unknown" && row.amount_usd === null));
  assert(!JSON.stringify(unknown).includes("elsewhere"));
  const period = { start: "2025-12-01T00:00:00Z", end: "2026-01-02T00:00:00Z", usd: "20", coverage: "complete" };
  const [bill] = billingPeriods({ periods: [period] });
  const now = Date.parse("2026-01-01T12:00:00Z");
  allocate(unknown, bill, 1100, now);
  assert(unknown.every(row => row.basis === "estimate" && row.amount_usd === "2.000000000000"));
  allocate(unknown, bill, 2200, bill.endMs);
  assert(unknown.every(row => row.basis === "actual" && row.amount_usd === "1.000000000000"));
  assert.throws(() => allocate(unknown, bill, 100, now));
  assert.throws(() => billingPeriods({ periods: [period, period] }));
  const { rows: partial } = await capture(scope);
  allocate(partial, { ...bill, coverage: "partial" }, 2200, now);
  assert(partial.every(row => row.basis === "unknown"));

});

test("validates receipt, credit and explicit zero, and rejects missing campaign or unknown-as-zero", () => {
  const expense = { expense_id: "test-123", category: "media", campaign: "test",
    amount_usd: "-1.329", occurred_at: "2026-01-01T00:00:00-07:00", basis: "actual" };
  assert.doesNotThrow(() => validateExpense(expense));
  assert.doesNotThrow(() => validateExpense({ ...expense, amount_usd: "0" }));
  assert.throws(() => validateExpense({ ...expense, campaign: undefined }));
  assert.throws(() => validateExpense({ ...expense, amount_usd: 0, basis: "unknown" }));
  assert.throws(() => validateExpense({ ...expense, amount_usd: "NaN" }));
  assert.throws(() => validateExpense({ ...expense, occurred_at: "2026-01-01" }));
});

test("sync finds a child's final response after archival and keeps unpriced counters if all rollouts disappear", async t => {
  const dir = await mkdtemp(join(tmpdir(), "pulsar-archived-costs-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const parent = "00000000-0000-0000-0000-000000000001", child = "00000000-0000-0000-0000-000000000002";
  const turn = "11111111-1111-1111-1111-111111111111", date = "2026-01-01T15:00:00Z";
  const original = join(dir, "dated"), archive = join(dir, "archived");
  await mkdir(original);
  const pathFor = (folder, thread) => join(folder, `rollout-${thread}.jsonl`);
  const context = { type: "turn_context", timestamp: date, payload: { turn_id: turn, root_turn_id: turn } };
  const response = (thread, id) => ({ type: "token_usage_record", timestamp: date, payload: {
    root_turn_id: turn, thread_id: thread, response_id: id, usage: { input_tokens: 9, output_tokens: 1 },
  } });
  const log = rows => rows.map(r => JSON.stringify(r)).join("\n") + "\n";
  await writeFile(pathFor(original, parent), log([context, response(parent, "parent")]));
  await writeFile(pathFor(original, child), log([context, response(child, "child")]));
  const sql = statement => execFileSync("sqlite3", [join(dir, "state_5.sqlite"), statement]);
  const literal = path => "'" + path.replaceAll("'", "''") + "'";
  sql(`CREATE TABLE threads (id TEXT, rollout_path TEXT, creator_account_id TEXT, model_provider TEXT);
    CREATE TABLE thread_spawn_edges (parent_thread_id TEXT, child_thread_id TEXT);
    INSERT INTO threads VALUES ('${parent}', ${literal(pathFor(original, parent))}, 'account', 'openai'),
      ('${child}', ${literal(pathFor(original, child))}, 'account', 'openai');
    INSERT INTO thread_spawn_edges VALUES ('${parent}', '${child}');`);
  const cli = fileURLToPath(new URL("./marketing/costs.mjs", import.meta.url));
  const run = action => execFileSync(process.execPath, [cli, action], {
    cwd: dir, env: { ...process.env, CODEX_HOME: dir, CODEX_THREAD_ID: child }, encoding: "utf8", stdio: "pipe",
  });
  const ledger = join(dir, ".marketing-costs");
  const rows = async () => (await readFile(join(ledger, turn, "expenses.jsonl"), "utf8")).trim().split("\n").map(s => JSON.parse(s));
  run("track");
  assert.equal((await rows()).length, 2);
  await writeFile(join(ledger, "subscription.json"), JSON.stringify({ periods: [{
    start: "2026-01-01T00:00:00Z", end: "2026-01-02T00:00:00Z", usd: "10", coverage: "complete",
    total_tokens: 100, total_tokens_as_of: "2026-01-02T00:00:00Z",
  }] }));
  await rename(original, archive);
  for (const id of [parent, child]) sql(`UPDATE threads SET rollout_path=${literal(pathFor(archive, id))} WHERE id='${id}';`);
  await writeFile(pathFor(archive, child), log([response(child, "final")]), { flag: "a" });
  run("sync");
  const final = await rows();
  assert.equal(final.length, 3);
  assert(final.every(r => r.basis === "actual" && Number(r.amount_usd) === 1));
  await rm(archive, { recursive: true });
  run("sync");
  const retained = await rows();
  assert.deepEqual(retained.map(r => r.expense_id), final.map(r => r.expense_id));
  assert(retained.every(r => r.basis === "unknown" && r.amount_usd === null));
});
