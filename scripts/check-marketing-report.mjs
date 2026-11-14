import assert from "node:assert/strict";
import test from "node:test";
import { parseAcquisitionEvent } from "../api/acquisition.ts";
import { buildReport } from "./marketing/report.mjs";

const day = new Date("2026-11-14T00:00:00.000Z");
const event = { playerId: "f2222222-2222-4222-8222-222222222222", source: "community", medium: "referral",
  campaign: "beat-clip", content: null, existingPlayer: false, firstSeenAt: day.toISOString(),
  occurredAt: day.toISOString(), type: "visit" };

test("only bounded first-touch labels and known game milestones reach the database", () => {
  assert.ok(parseAcquisitionEvent(event));
  assert.equal(parseAcquisitionEvent({ ...event, source: "https://unwanted.invalid/private?q=other" }), null);
  assert.equal(parseAcquisitionEvent({ ...event, type: "run_started" }), null);
  assert.equal(parseAcquisitionEvent({ ...event, type: "purchase", runId: event.playerId }), null);
  assert.equal(parseAcquisitionEvent({ ...event, firstSeenAt: "yesterday" }), null);
  assert.ok(parseAcquisitionEvent({ ...event, type: "rhythm_12", runId: event.playerId }));
});

const touch = (campaign, qualified) => ({ campaign, source: "site", medium: "referral", content: null,
  knownReturning: 1, newBrowsers: 8, played: 5, playedTwice: 4, reached12: 3, qualified,
  mature7d: 4, qualifiedIn7d: 1 });
const cost = (campaign, category, basis, usd) => ({ campaign, category, basis, usd, entries: 1 });

test("overall acquisition charges shared compute and campaigns with no visitors; organic plays stay separate", () => {
  const report = buildReport([touch("a", 2), touch(null, 3)], [
    cost("a", "media", "actual", "5"), cost("no-traffic", "media", "actual", "3"),
    cost(null, "compute", "estimate", "2")], day);
  assert.equal(report.taggedAcquisition.costPerQualifiedUsd, 5);
  assert.equal(report.campaigns[0].directCost.costPerQualifiedUsd, 2.5);
  assert.equal(report.sharedOverhead.estimatedUsd, 2);
  assert.equal(report.campaigns[1].directCost.costPerQualifiedUsd, null);
  assert.equal(report.untagged.qualified, 3);
});

test("withhold the dollar metric for missing prices, uncovered campaigns, missing compute or zero conversions", () => {
  const rows = [touch("a", 1)];
  const reported = expenses => buildReport(rows, expenses, day).taggedAcquisition;
  const actual = cost("a", "media", "actual", "10");
  assert.equal(reported([actual, cost("a", "compute", "unknown", "0")]).costPerQualifiedUsd, null);
  assert.deepEqual(reported([actual]).reasons, ["missing_compute"]);
  assert.deepEqual(reported([cost(null, "compute", "actual", "1")]).missingExpenseCampaigns, ["a"]);
  assert.equal(reported([cost("a", "compute", "actual", "0")]).costPerQualifiedUsd, 0);
  assert.equal(buildReport([], [actual], day).taggedAcquisition.costPerQualifiedUsd, null);
});
