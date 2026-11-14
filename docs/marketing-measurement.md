# Measuring player acquisition

A new browser qualifies once it starts two distinct playable runs and reaches a peak rhythm of at least 12 in any run. Either condition can come first. A tutorial counts after the player takes control. Leaving before game over preserves the start and any peak already reached. Calibration, replays, beta runs, and score submission do not count as starts.

## Running an experiment

1. Give each independently costed experiment a fresh, case-sensitive `utm_campaign`. For example, a link for a rhythm-game audience could be `https://playpulsar.com/?utm_source=rhythm-community&utm_medium=community&utm_campaign=necrodancer-clip-01&utm_content=beat-drop`. Use `utm_content` to distinguish creatives sharing a budget, or separate campaign IDs if each creative has its own spend.
2. In every Codex turn spent on that experiment, run `npm run marketing:costs -- track --campaign necrodancer-clip-01`. Run `track` without a campaign for shared acquisition work. The same turn includes its subagents. Import receipts with their original expense IDs and matching campaign tag. Keep launch prep and unsuccessful experiments in the ledger.
3. Run the following from the project with its database configured. Sync again after the earlier turn ends to capture its last response. For the cost of the report-reading turn itself, register that turn too.

```sh
npm run marketing:costs -- sync --publish
npm run --silent marketing:report
```

The first command imports the staged ledger. The second prints JSON for an agent or a person to compare. Supply `-- --as-of 2026-11-14T00:00:00Z` to the report to use a specific event-time cutoff. Later deliveries and reconciled expenses can revise an earlier report. Billing-period setup, supported receipts, and subscription allocation are described in [Marketing expenses](marketing-expenses.md).

## Reading the report

- `taggedAcquisition.costPerQualifiedUsd` divides **all recorded marketing expenses** by unique qualified new browsers first acquired through a campaign tag. The numerator includes shared compute, other overhead and campaigns that produced zero plays. `totalSpend` shows actual USD, estimated USD and metered Codex tokens. An allocation made from a monthly budget or local-only usage remains an estimate.
- `campaigns[].directCost` uses only the costs assigned to that campaign. Shared setup appears once in the headline. A campaign with spend and zero conversions remains visible with its spend and a null ratio.
- `firstTouches` breaks visits, first play, second play, peak rhythm and qualification down by source, medium, campaign and creative. `knownReturning` counts browsers with a preexisting run marker at first measurement. Those browsers and untagged acquisitions are excluded from the headline denominator. `untagged` shows the untagged funnel separately.
- `qualifiedIn7d / mature7d` compares conversion rates for visitors who have each had a full 168 hours to play. `qualified` includes later conversions as they occur. When comparing two launches of different ages, use the seven-day counts alongside the lifetime cost and sample sizes.
- A null ratio has machine-readable `reasons`. Reconcile unpriced entries and missing campaign expenses before comparing dollar results. A campaign with genuinely zero direct expenses can record an explicit zero. Expenses from outside the ledger must be imported for the total to cover them.

Attribution persists the first landing in browser storage, including an initial direct visit. An external untagged referral contributes its hostname. An account is optional. Clearing storage, switching browser or device, and some privacy settings limit deduplication. The figures measure first-touch attribution; causal lift would require a controlled comparison.

## Collection and verification

The production Vercel build applies the additive Prisma migrations through the existing build command. Collection defaults to enabled on Vercel production and disabled in previews and local development. To exercise the normal HTTP path locally, point both database URLs at an isolated test database, run `npm run db:deploy`, then run `ACQUISITION_TRACKING=1 npm run dev`. The server accepts only the bounded anonymous event fields used by the report. Expense import and reporting use an operator's database connection.

`npm run check:marketing` checks source retention, repeat play, the rhythm threshold, delivery retries, expense handling, and report arithmetic.
