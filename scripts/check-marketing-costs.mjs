import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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

  const unknown = await capture(scope);
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
  const partial = await capture(scope);
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
