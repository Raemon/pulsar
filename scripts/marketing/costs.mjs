// Operator-side ledger. Only sanitized usage counters and expense records leave this machine.
import "dotenv/config";
import { spawnSync } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { resolve, join, dirname } from "node:path";
import { homedir } from "node:os";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

const stage = resolve(".marketing-costs");
const uuid = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i;
const categories = ["compute", "media", "creative", "tools", "other"];

function checkCampaign(value) {
  if (value !== null && (typeof value !== "string" || !value || value.length > 100 || /[\u0000-\u001f\u007f/?#=&]/.test(value) || value !== value.trim())) {
    throw new Error("Use the exact utm_campaign label, or null for shared overhead");
  }
}

export function validateExpense(row) {
  if (!row || typeof row.expense_id !== "string" || !row.expense_id.trim() || row.expense_id.length > 255) {
    throw new Error("Each expense needs a stable expense_id of 1–255 characters");
  }
  // Require campaign explicitly so a misspelled/missing tag cannot silently become overhead.
  checkCampaign(row.campaign);
  if (!categories.includes(row.category) || !["actual", "estimate", "unknown"].includes(row.basis)) {
    throw new Error(`Invalid category or basis on ${row.expense_id}`);
  }
  if (typeof row.occurred_at !== "string" || !/(?:Z|[+-]\d\d:\d\d)$/i.test(row.occurred_at)
      || !Number.isFinite(Date.parse(row.occurred_at))) {
    throw new Error(`Expected a timestamp with timezone on ${row.expense_id}`);
  }
  if (row.basis === "unknown" ? row.amount_usd !== null
    : !["string", "number"].includes(typeof row.amount_usd) || !/^-?\d{1,14}(?:\.\d{1,12})?$/.test(String(row.amount_usd))) {
    throw new Error(`Expected USD with up to 12 decimals, or null for unknown, on ${row.expense_id}`);
  }
  if (row.details === undefined) row.details = {};
  if (!row.details || typeof row.details !== "object" || Array.isArray(row.details)) throw new Error("details must be an object");
  return row;
}

// Rollouts put type before payload. Only parse first-party usage lines. Conversation
// text can quote usage records, so searching arbitrary line contents would be unsafe.
async function* recordsOfType(path, type = "token_usage_record") {
  const stream = createReadStream(path);
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      const header = line.slice(0, 240);
      const end = header.indexOf('"payload"');
      if (end >= 0 && header.slice(0, end).match(/"type"\s*:\s*"([a-z_]+)"/)?.[1] === type) {
        yield JSON.parse(line);
      }
    }
  } finally { stream.destroy(); }
}

export async function capture({ logs, turn, campaign, threadId }) {
  if (!uuid.test(turn) || !Array.isArray(logs) || (!threadId && !logs.length)) throw new Error("A root turn UUID and rollout source are required");
  checkCampaign(campaign);
  const paths = new Set();
  let complete = true;
  if (threadId) {
    if (!uuid.test(threadId)) throw new Error("Invalid registered Codex thread ID");
    // A child can register the turn. Walk up to the parent, then down to all
    // descendants. root_turn_id below selects only responses from this turn.
    try {
      const threads = queryIndex(`WITH RECURSIVE ancestors(id) AS (
        VALUES ('${threadId}') UNION SELECT parent_thread_id FROM thread_spawn_edges JOIN ancestors ON child_thread_id=id
      ), family(id) AS (
        SELECT id FROM ancestors UNION SELECT child_thread_id FROM thread_spawn_edges JOIN family ON parent_thread_id=id
      ) SELECT t.rollout_path FROM family f LEFT JOIN threads t ON t.id=f.id`);
      for (const t of threads) {
        if (t.rollout_path) paths.add(t.rollout_path);
        else complete = false;
      }
    } catch { complete = false; }
  }
  const indexed = paths.size > 0;
  for (const directory of logs) {
    try {
      for (const file of await readdir(directory)) if (/^rollout-.*\.jsonl$/.test(file)) paths.add(join(directory, file));
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
      if (!indexed) complete = false;
    }
  }
  const rows = new Map();
  for (const path of paths) {
    try {
      for await (const record of recordsOfType(path)) {
        const item = record.payload;
        if (item.root_turn_id !== turn) continue;
        if (typeof item.response_id !== "string" || !item.response_id || !uuid.test(item.thread_id)) {
          throw new Error("Missing response or thread ID on usage record");
        }
        const { input_tokens, cached_input_tokens = 0, output_tokens } = item.usage ?? {};
        if ([input_tokens, cached_input_tokens, output_tokens].some(n => !Number.isSafeInteger(n) || n < 0)
            || cached_input_tokens > input_tokens) throw new Error("Unexpected token accounting format");
        const expense = validateExpense({
          expense_id: "codex:" + createHash("sha256").update(item.response_id).digest("hex"), occurred_at: record.timestamp,
          category: "compute", campaign, amount_usd: null, basis: "unknown",
          details: { thread_id: item.thread_id, input_tokens, cached_input_tokens, output_tokens, allocation: "subscription" },
        });
        const old = rows.get(expense.expense_id);
        if (old && JSON.stringify(old) !== JSON.stringify(expense)) throw new Error("Conflicting copies of a response usage record");
        rows.set(expense.expense_id, expense);
      }
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
      complete = false;
    }
  }
  return { rows: [...rows.values()], complete: complete && rows.size > 0 };
}

function queryIndex(statement) {
  const db = join(process.env.CODEX_HOME || join(homedir(), ".codex"), "state_5.sqlite");
  const result = spawnSync("sqlite3", ["-readonly", "-json", db, statement], { encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error("Could not read local Codex thread usage index");
  return JSON.parse(result.stdout.trim() || "[]");
}

function instant(s) {
  if (typeof s !== "string" || !/(?:Z|[+-]\d\d:\d\d)$/i.test(s) || !Number.isFinite(Date.parse(s))) {
    throw new Error("Billing periods need ISO timestamps with timezone");
  }
  return Date.parse(s);
}

export function billingPeriods(bill) {
  if (!Array.isArray(bill.periods) || !bill.periods.length) throw new Error("Supply at least one subscription billing period");
  const periods = bill.periods.map(p => {
    const start = instant(p.start), end = instant(p.end);
    const basis = p.basis ?? "invoice";
    if (start >= end || !["complete", "partial", "observed"].includes(p.coverage) || !["invoice", "budget"].includes(basis)
        || !/^\d{1,9}(?:\.\d{1,6})?$/.test(String(p.usd))) throw new Error("Invalid period, coverage, basis or USD price");
    if (p.coverage === "observed" && p.total_tokens !== undefined) throw new Error("Observed coverage uses this installation's metered tokens");
    if (p.total_tokens !== undefined && (!Number.isSafeInteger(p.total_tokens) || p.total_tokens <= 0)) {
      throw new Error("Provided whole-account billing-period total_tokens must be a positive integer");
    }
    const throughMs = p.total_tokens === undefined ? null : instant(p.total_tokens_as_of);
    if (throughMs !== null && throughMs <= start) throw new Error("External token cutoff must follow the period start");
    const [whole, fraction = ""] = String(p.usd).split(".");
    return { ...p, basis, startMs: start, endMs: end, throughMs, picoUsd: BigInt(whole + fraction.padEnd(12, "0")) };
  }).sort((a, b) => a.startMs - b.startMs);
  if (periods.some((p, i) => i && periods[i - 1].endMs > p.startMs)) throw new Error("Subscription billing periods overlap");
  return periods;
}

export function allocate(rows, period, denominator, now, incompleteRollouts = 0) {
  if (period.coverage === "partial" || !denominator) return;
  const tokens = r => r.details.input_tokens + r.details.output_tokens;
  if (rows.reduce((sum, r) => sum + tokens(r), 0) > denominator) throw new Error("Campaign usage exceeds whole-account total_tokens");
  for (const row of rows) {
    const divisor = BigInt(denominator);
    const digits = ((period.picoUsd * BigInt(tokens(row)) + divisor / 2n) / divisor).toString().padStart(13, "0");
    row.amount_usd = digits.slice(0, -12) + "." + digits.slice(-12);
    row.basis = period.basis === "invoice" && period.coverage === "complete" && now >= period.endMs ? "actual" : "estimate";
    Object.assign(row.details, { period_start: period.start, period_end: period.end, subscription_usd: String(period.usd),
      subscription_basis: period.basis, coverage: period.coverage,
      ...(period.coverage === "observed" ? { observed_account_tokens: denominator, incomplete_rollouts: incompleteRollouts }
        : { total_account_tokens: denominator }),
      denominator_source: period.total_tokens ? "provided" : "local Codex usage",
      denominator_as_of: new Date(Math.min(period.throughMs ?? now, period.endMs)).toISOString(), weighted_tokens: tokens(row) });
  }
}

// The index identifies the subscription account's active and archived rollouts.
// Only aggregate counters are retained from non-marketing activity.
async function accountDenominator(account, period, now) {
  const start = Math.floor(period.startMs / 1000), end = Math.ceil(Math.min(now, period.endMs) / 1000);
  const safeAccount = "'" + account.replaceAll("'", "''") + "'";
  const threads = queryIndex(`SELECT id, rollout_path, tokens_used FROM threads WHERE model_provider='openai'
    AND creator_account_id=${safeAccount} AND created_at < ${end} AND updated_at >= ${start}`);
  let total = 0, incompleteRollouts = 0;
  const seen = new Set();
  for (const thread of threads) {
    let currentFormat = false, incomplete = false;
    try {
      for await (const r of recordsOfType(thread.rollout_path)) {
        const p = r.payload;
        if (p.thread_id !== thread.id) continue; // Forked transcripts can include their parent's counters.
        currentFormat = true;
        const timestamp = instant(r.timestamp);
        if (timestamp < period.startMs || timestamp >= Math.min(period.endMs, now) || seen.has(p.response_id)) continue;
        if (!p.response_id || ![p.usage?.input_tokens, p.usage?.output_tokens].every(n => Number.isSafeInteger(n) && n >= 0)) {
          incomplete = true;
          continue;
        }
        seen.add(p.response_id);
        total += p.usage.input_tokens + p.usage.output_tokens;
        if (!Number.isSafeInteger(total)) throw new Error("Account token total exceeds supported precision");
      }
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
      incomplete = true;
    }
    if (incomplete || (thread.tokens_used > 0 && !currentFormat)) {
      if (period.coverage !== "observed") return { tokens: null, incompleteRollouts: 1 };
      incompleteRollouts++;
    }
  }
  return { tokens: total, incompleteRollouts };
}

async function applySubscription(groups, bill) {
  const all = groups.flatMap(group => group.rows);
  const ids = [...new Set(all.map(r => r.details.thread_id))];
  // capture() validates UUIDs. A subscription file applies to one account.
  const threads = queryIndex(`SELECT id, creator_account_id FROM threads WHERE model_provider='openai'
    AND id IN (${ids.map(id => "'" + id + "'").join(",")})`);
  const accounts = new Set(threads.map(t => t.creator_account_id).filter(Boolean));
  if (accounts.size > 1) throw new Error("Registered marketing turns span multiple accounts; use a separate ledger per subscription");
  const account = [...accounts][0];
  if (!account) return;
  const matched = new Set(threads.filter(t => t.creator_account_id === account).map(t => t.id));
  const now = Date.now();
  for (const period of billingPeriods(bill)) {
    if (period.throughMs !== null && period.throughMs > now) throw new Error("External token cutoff is in the future");
    if (now >= period.endMs && period.throughMs !== null && period.throughMs < period.endMs) continue;
    const cutoff = Math.min(now, period.endMs, period.throughMs ?? now);
    const rows = all.filter(row => {
      const time = instant(row.occurred_at);
      return matched.has(row.details.thread_id) && time >= period.startMs && time < cutoff;
    });
    if (!rows.length || period.coverage === "partial") continue;
    const denominator = period.total_tokens ? { tokens: period.total_tokens, incompleteRollouts: 0 }
      : await accountDenominator(account, period, now);
    allocate(rows, period, denominator.tokens, now, denominator.incompleteRollouts);
  }
}

export function importExpenses(expenses) {
  if (!expenses.length) throw new Error("Expense import is empty");
  const url = process.env.DIRECT_DATABASE_URL || process.env.DATABASE_URL;
  if (!url) throw new Error("Set DIRECT_DATABASE_URL or DATABASE_URL before importing");
  const validated = expenses.map(validateExpense);
  if (new Set(validated.map(r => r.expense_id)).size !== validated.length) throw new Error("Duplicate expense IDs in import");
  // Base64 gives a fixed, quote-free alphabet when sending JSON via psql stdin.
  const data = Buffer.from(JSON.stringify(validated.map(row => {
    if (row.details.allocation !== "subscription") return row;
    const { thread_id, ...details } = row.details;
    return { ...row, details };
  }))).toString("base64");
  const sql = `
BEGIN;
CREATE TEMP TABLE incoming ON COMMIT DROP AS
  SELECT * FROM jsonb_populate_recordset(NULL::marketing_expenses,
    convert_from(decode('${data}','base64'), 'UTF8')::jsonb);
INSERT INTO marketing_expenses SELECT * FROM incoming ORDER BY expense_id
ON CONFLICT (expense_id) DO UPDATE
SET amount_usd = excluded.amount_usd, basis = excluded.basis, occurred_at = excluded.occurred_at,
    details = excluded.details
WHERE marketing_expenses.campaign IS NOT DISTINCT FROM excluded.campaign AND marketing_expenses.category = excluded.category
  AND CASE WHEN excluded.details->>'allocation' = 'subscription' THEN
        marketing_expenses.details->>'allocation' = 'subscription' OR marketing_expenses.basis <> 'actual'
      ELSE
        CASE marketing_expenses.basis WHEN 'actual' THEN 2 WHEN 'estimate' THEN 1 ELSE 0 END <=
        CASE excluded.basis WHEN 'actual' THEN 2 WHEN 'estimate' THEN 1 ELSE 0 END
      END;
DO $$ BEGIN
  IF EXISTS (SELECT FROM incoming i JOIN marketing_expenses e USING (expense_id)
             WHERE e.campaign IS DISTINCT FROM i.campaign OR e.category <> i.category) THEN
    RAISE EXCEPTION 'An expense ID already belongs to another campaign or category';
  END IF;
END $$;
COMMIT;`;
  const db = new URL(url);
  if (!["postgres:", "postgresql:"].includes(db.protocol)) throw new Error("Expected a PostgreSQL connection URL");
  const env = { ...process.env };
  const password = db.searchParams.get("password") ?? decodeURIComponent(db.password);
  if (password) env.PGPASSWORD = password;
  db.password = "";
  db.searchParams.delete("password");
  const result = spawnSync("psql", ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-d", db.href, "-f", "-"], {
    env, input: sql, encoding: "utf8",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr.trim());
}

async function readJson(path) { return JSON.parse(await readFile(path, "utf8")); }

async function writeAtomically(path, content) {
  const tmp = path + "." + randomUUID() + ".tmp";
  await writeFile(tmp, content, { mode: 0o600 });
  await rename(tmp, path);
}

async function refreshScope(scope) {
  const { rows: fresh, complete } = await capture(scope);
  const byId = new Map(fresh.map(row => [row.expense_id, row]));
  // Keep usage previously observed in other rollout files, e.g. a child that
  // has since been archived. Revalue its raw counters with the current bill.
  let prior;
  try { prior = await readFile(join(stage, scope.turn, "expenses.jsonl"), "utf8"); }
  catch (err) { if (err.code !== "ENOENT") throw err; }
  for (const line of (prior ?? "").split(/\r?\n/).filter(Boolean)) {
    const row = validateExpense(JSON.parse(line));
    if (byId.has(row.expense_id)) continue;
    const { thread_id, input_tokens, cached_input_tokens, output_tokens } = row.details;
    if (row.campaign !== scope.campaign || row.category !== "compute" || !uuid.test(thread_id)
        || !/^codex:[0-9a-f]{64}$/.test(row.expense_id)
        || ![input_tokens, cached_input_tokens, output_tokens].every(n => Number.isSafeInteger(n) && n >= 0)) {
      throw new Error("Invalid previously staged compute counters");
    }
    byId.set(row.expense_id, { ...row, amount_usd: null, basis: "unknown",
      details: { thread_id, input_tokens, cached_input_tokens, output_tokens, allocation: "subscription" } });
  }
  if (!byId.size) throw new Error("No per-response usage found for the registered turn");
  const rows = [...byId.values()].sort((a, b) => a.expense_id.localeCompare(b.expense_id));
  return { scope, rows, complete: complete && rows.length === fresh.length };
}

async function sync(extraScope, publish) {
  await mkdir(stage, { recursive: true, mode: 0o700 });
  const turns = (await readdir(stage)).filter(name => uuid.test(name)).sort();
  const scopes = new Map();
  for (const turn of turns) scopes.set(turn, await readJson(join(stage, turn, "scope.json")));
  if (extraScope) {
    const prior = scopes.get(extraScope.turn);
    if (prior && prior.campaign !== extraScope.campaign) throw new Error("Turn already tracked with a different campaign");
    extraScope.logs = [...new Set([...(prior?.logs ?? []), ...extraScope.logs])];
    if (!extraScope.threadId && prior?.threadId) extraScope.threadId = prior.threadId;
    scopes.set(extraScope.turn, extraScope);
  }
  if (!scopes.size) throw new Error("Register a turn with track first");
  const groups = [];
  for (const scope of scopes.values()) groups.push(await refreshScope(scope));
  let bill;
  try { bill = await readJson(join(stage, "subscription.json")); } catch (err) { if (err.code !== "ENOENT") throw err; }
  const verified = groups.filter(group => group.complete);
  if (bill && verified.length) await applySubscription(verified, bill);
  for (const { scope, rows, complete } of groups) {
    if (!complete) console.warn("Incomplete rollout coverage: retained observed counters; compute is unpriced until coverage is restored.");
    const dir = join(stage, scope.turn);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeAtomically(join(dir, "scope.json"), JSON.stringify(scope, null, 2) + "\n");
    const file = join(dir, "expenses.jsonl");
    await writeAtomically(file, rows.map(r => JSON.stringify(r)).join("\n") + "\n");
    const unknown = rows.filter(r => r.basis === "unknown").length;
    console.log(`${rows.length} compute responses, ${unknown} unpriced. Staged at ${file}`);
  }
  if (publish) {
    importExpenses(groups.flatMap(g => g.rows));
    console.log("Imported registered marketing expenses.");
  }
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true, options: { turn: { type: "string" }, logs: { type: "string", multiple: true },
      campaign: { type: "string" }, publish: { type: "boolean" } },
  });
  const [action, file] = positionals;
  if (action === "track") {
    // The active Codex chat can register its own turn without asking the operator for a rollout path.
    let turn = values.turn;
    const logs = (values.logs ?? []).map(p => resolve(p));
    if (!turn) {
      const thread = process.env.CODEX_THREAD_ID;
      if (!uuid.test(thread)) throw new Error("Use --turn and --logs outside an active Codex chat");
      const [row] = queryIndex(`SELECT rollout_path FROM threads WHERE id='${thread}'`);
      if (!row) throw new Error("Active chat rollout unavailable");
      let turnTime;
      for await (const record of recordsOfType(row.rollout_path, "turn_context")) {
        turn = record.payload.root_turn_id || record.payload.turn_id;
        turnTime = new Date(record.timestamp);
      }
      if (!uuid.test(turn) || !Number.isFinite(turnTime?.getTime())) throw new Error("Current turn unavailable; supply --turn");
      const path = dirname(row.rollout_path);
      if (!logs.includes(path)) logs.push(path);
      // A long-lived chat's parent rollout may precede the folder used for newly spawned children.
      const sessionRoot = join(process.env.CODEX_HOME || join(homedir(), ".codex"), "sessions");
      const today = join(sessionRoot, String(turnTime.getFullYear()), String(turnTime.getMonth() + 1).padStart(2, "0"),
        String(turnTime.getDate()).padStart(2, "0"));
      if (!logs.includes(today)) {
        try { await readdir(today); logs.push(today); } catch (err) { if (err.code !== "ENOENT") throw err; }
      }
    }
    await sync({ turn, logs, campaign: values.campaign ?? null, ...(!values.turn ? { threadId: process.env.CODEX_THREAD_ID } : {}) }, values.publish);
  } else if (action === "sync") {
    await sync(undefined, values.publish);
  } else if (action === "import" && file) {
    const rows = (await readFile(file, "utf8")).split(/\r?\n/).filter(s => s.trim()).map(s => JSON.parse(s));
    importExpenses(rows);
    console.log(`Imported ${rows.length} expense records.`);
  } else throw new Error("Use track [--turn ID --logs DIR] [--campaign ID], sync [--publish], or import FILE.jsonl");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(err => { console.error(err.message); process.exitCode = 1; });
}
