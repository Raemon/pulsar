# Acquisition expenses

From the Pulsar checkout, register each marketing turn when it starts. A Codex agent can register itself and all subagents for that turn. Use the same campaign label as the acquisition link. Omit the campaign flag for work shared across campaigns, including measurement setup.

```sh
npm run marketing:costs -- track --campaign rhythm-demo
npm run marketing:costs -- sync
```

The first command finds the current root turn in the local Codex index. The second follows registered agents and their descendants across dated or archived rollouts, including responses generated after the previous refresh. If a source disappears, it retains staged counters and marks that turn's compute unpriced until coverage is restored. Run it again from a later turn to capture the previous turn's final response. Both commands stage data privately in the ignored `.marketing-costs/` folder. They require the local Codex rollouts with per-response usage records. Automatic turn discovery also uses the `sqlite3` command.

Outside a Codex chat, use `track --turn <root-turn-uuid> --logs <rollout-directory>`. Pass `--logs` again for each additional directory containing a parent or child rollout. For a turn spanning dates, include all applicable dated directories when updating its registration.

## Allocate a subscription

Put the USD amount, period boundaries and coverage basis in `.marketing-costs/subscription.json`. Add a period for each bill. The start instant is inclusive, and the end instant is exclusive. For a provisional monthly budget, use a calendar month in America/Los_Angeles and set the two offsets for the corresponding dates.

```json
{
  "periods": [
    {
      "start": "2026-11-01T00:00:00-07:00",
      "end": "2026-12-01T00:00:00-08:00",
      "usd": "200.00",
      "basis": "budget",
      "coverage": "observed"
    }
  ]
}
```

The provisional estimate is the full monthly budget multiplied by the response's share of same-account Codex tokens observed on this installation during the month to date. The ledger records the budget, observed token denominator, coverage basis and count of indexed rollouts with missing counters. Usage on other devices or absent local records can increase the true denominator and reduce this share. An agent can roll the same working budget forward each calendar month until it is corrected. Budget-based or observed-only amounts stay estimates after month end.

For reconciliation, replace the provisional intervals with the actual billed periods and amounts. Use `"basis": "invoice"` (the default) and `"coverage": "complete"` when the denominator covers the whole account. The response receives its share of the subscription charge for that period. The weight is input tokens plus output tokens. Input already includes cached input, and output already includes reasoning. Every token carries the same weight. Each response gets a stable expense ID shared across retries and transcript forks.

With local metering, `complete` means the local Codex records represent the subscription's entire Codex usage through the current instant or the period end, whichever comes first. The importer identifies the subscription account from registered marketing threads and reads per-response usage counters from that account's indexed active and archived rollouts. For multiple devices, supply a verified whole-account `total_tokens` and its exclusive ISO timestamp cutoff in `total_tokens_as_of`, then set `coverage` to `complete`. An external denominator applies only to responses before its cutoff. Refresh both fields when new usage occurs. A closed period needs a cutoff covering the period end. If coverage is unknown, use `"coverage": "partial"`. Missing bills, incomplete coverage, and unsupported or missing local metering leave the applicable responses unpriced.

Open billing periods produce estimates that change as more usage arrives. After a verified billing period closes, complete usage produces the allocated share of the actual invoice, rounded to 12 decimal places per response. Use one billing configuration per subscription account. Register shared setup once with no campaign specified. Enter subscription compute through this allocation only so the same bill cannot be charged twice.

## Publish and reconcile

After the Prisma migrations have been applied to the chosen database, publish with the PostgreSQL `psql` client installed. The importer uses `DIRECT_DATABASE_URL` when set, otherwise `DATABASE_URL`.

```sh
npm run marketing:costs -- sync --publish
npm run marketing:report
```

Import ad charges, creative services, tools, non-subscription compute and other expenses using one JSON object per line. Supply a stable provider-prefixed receipt ID for every line item and preserve it for corrections. Use a negative amount for a credit. An explicitly reconciled zero is an actual expense of zero, and a pending invoice uses `"basis":"unknown","amount_usd":null`.

```jsonl
{"expense_id":"ads:invoice-123:line-1","campaign":"rhythm-demo","category":"media","occurred_at":"2026-11-14T12:00:00Z","amount_usd":"8.32","basis":"actual","details":{"source":"provider billing export"}}
```

```sh
npm run marketing:costs -- import /path/to/receipts.jsonl
```

Set `campaign` to `null` for shared expenses. Supported categories are `compute`, `media`, `creative`, `tools` and `other`. Re-importing a receipt updates the same row, and an estimate can be replaced by a reconciled actual amount. All rows in a file are applied together. A ledger total covers the registered turns and imported expenses.
