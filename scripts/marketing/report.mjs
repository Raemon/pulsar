import "dotenv/config";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

// Each player contributes to exactly one first-touch group. Compute the two
// conditions on that player's distinct runs before counting people in a group.
async function readFunnel(db, asOf) {
  return db.$queryRaw`
    WITH players AS (
      SELECT p.*, count(r.run_id)::int AS starts,
        bool_or(r.rhythm_12_at <= ${asOf}) AS reached_12,
        count(r.run_id) FILTER (WHERE r.started_at <= p.first_seen_at + interval '168 hours') AS starts_7d,
        bool_or(r.rhythm_12_at <= p.first_seen_at + interval '168 hours') AS rhythm_7d
      FROM acquisition_players p
      LEFT JOIN acquisition_runs r ON r.player_id = p.id AND r.started_at <= ${asOf}
      WHERE p.first_seen_at <= ${asOf}
      GROUP BY p.id
    )
    SELECT campaign, source, medium, content,
      count(*) FILTER (WHERE existing_player)::int AS "knownReturning",
      count(*) FILTER (WHERE NOT existing_player)::int AS "newBrowsers",
      count(*) FILTER (WHERE NOT existing_player AND starts >= 1)::int AS "played",
      count(*) FILTER (WHERE NOT existing_player AND starts >= 2)::int AS "playedTwice",
      count(*) FILTER (WHERE NOT existing_player AND reached_12)::int AS "reached12",
      count(*) FILTER (WHERE NOT existing_player AND starts >= 2 AND reached_12)::int AS qualified,
      count(*) FILTER (WHERE NOT existing_player AND first_seen_at + interval '168 hours' <= ${asOf})::int AS "mature7d",
      count(*) FILTER (WHERE NOT existing_player AND first_seen_at + interval '168 hours' <= ${asOf}
        AND starts_7d >= 2 AND rhythm_7d)::int AS "qualifiedIn7d"
    FROM players GROUP BY campaign, source, medium, content
    ORDER BY campaign NULLS LAST, source, medium, content`;
}

async function readExpenses(db, asOf) {
  return db.$queryRaw`
    SELECT campaign, category, basis, count(*)::int AS entries,
      coalesce(sum(amount_usd), 0)::text AS usd
    FROM marketing_expenses WHERE occurred_at <= ${asOf}
    GROUP BY campaign, category, basis ORDER BY campaign NULLS LAST, category, basis`;
}

function funnel(rows) {
  const total = { knownReturning: 0, newBrowsers: 0, played: 0, playedTwice: 0, reached12: 0,
    qualified: 0, mature7d: 0, qualifiedIn7d: 0 };
  for (const row of rows) {
    for (const key of Object.keys(total)) total[key] += row[key];
  }
  return total;
}

const usd = n => Number(n.toFixed(10));

function spending(rows) {
  let actual = 0, estimated = 0, unknownEntries = 0, entries = 0;
  const knownByCategoryUsd = {};
  for (const row of rows) {
    entries += row.entries;
    if (row.basis === "unknown") {
      unknownEntries += row.entries;
      continue;
    }
    const amount = Number(row.usd);
    if (row.basis === "actual") actual += amount;
    else estimated += amount;
    knownByCategoryUsd[row.category] = usd((knownByCategoryUsd[row.category] ?? 0) + amount);
  }
  return { entries, unknownEntries, actualUsd: usd(actual), estimatedUsd: usd(estimated),
    knownUsd: usd(actual + estimated), knownByCategoryUsd };
}

function costMetric(spend, qualified, gaps = []) {
  const reasons = [...gaps];
  if (spend.entries === 0) reasons.push("no_recorded_expenses");
  if (spend.unknownEntries > 0) reasons.push("unpriced_expenses");
  if (qualified === 0) reasons.push("no_qualified_players");
  return { costPerQualifiedUsd: reasons.length ? null : usd(spend.knownUsd / qualified), reasons };
}

export function buildReport(touches, expenses, asOf) {
  const names = [...new Set([...touches, ...expenses].map(row => row.campaign).filter(name => name !== null))].sort();
  const campaigns = names.map(campaign => {
    const audience = funnel(touches.filter(row => row.campaign === campaign));
    const spend = spending(expenses.filter(row => row.campaign === campaign));
    return { campaign, ...audience, directSpend: spend, directCost: costMetric(spend, audience.qualified) };
  });
  // The headline charges the entire marketing ledger, including shared setup
  // and campaigns with zero conversions. Untagged players do not lower it.
  const tagged = funnel(touches.filter(row => row.campaign !== null));
  const allSpend = spending(expenses);
  const missingExpenseCampaigns = campaigns.filter(c => c.newBrowsers && !c.directSpend.entries).map(c => c.campaign);
  const gaps = [];
  if (missingExpenseCampaigns.length) gaps.push("campaigns_missing_expenses");
  if (!expenses.some(row => row.category === "compute")) gaps.push("missing_compute");
  return { asOf: asOf.toISOString(), taggedAcquisition: { ...tagged, totalSpend: allSpend,
    ...costMetric(allSpend, tagged.qualified, gaps), missingExpenseCampaigns },
    sharedOverhead: spending(expenses.filter(row => row.campaign === null)),
    campaigns, untagged: funnel(touches.filter(row => row.campaign === null)), firstTouches: touches };
}

export async function readReport(db, asOf) {
  // Use a single snapshot so a concurrent event or expense import cannot
  // contribute to only one side of this report.
  const [touches, expenses] = await db.$transaction(async tx =>
    [await readFunnel(tx, asOf), await readExpenses(tx, asOf)], { isolationLevel: "RepeatableRead" });
  return buildReport(touches, expenses, asOf);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({ options: { "as-of": { type: "string" } } });
  const asOf = values["as-of"] ? new Date(values["as-of"]) : new Date();
  if (!Number.isFinite(+asOf)) throw new Error("Use an ISO date or timestamp for --as-of");
  if (+asOf > Date.now()) throw new Error("--as-of cannot be in the future");
  const { prisma } = await import("../../api/_lib/prisma.ts");
  try {
    console.log(JSON.stringify(await readReport(prisma, asOf), null, 2));
  } finally {
    await prisma.$disconnect();
  }
}
