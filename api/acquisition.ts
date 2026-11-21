import type { VercelRequest, VercelResponse } from "@vercel/node";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isId = (v: unknown): v is string => typeof v === "string" && uuid.test(v);
const isTag = (v: unknown): v is string =>
  typeof v === "string" && v.trim() === v && v.length > 0 && v.length <= 100 &&
  !/[\u0000-\u001f\u007f/?#=&]/.test(v);

function timestamp(v: unknown, now: number) {
  if (typeof v !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v)) return null;
  const time = Date.parse(v);
  if (!Number.isFinite(time) || time < Date.UTC(2020, 0, 1)) return null;
  return new Date(Math.min(time, now));
}

export function parseAcquisitionEvent(body: unknown, now = Date.now()) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const { playerId, source, medium, campaign, content, existingPlayer, type, runId,
    firstSeenAt: seen, occurredAt: occurred } = body as Record<string, unknown>;
  const firstSeenAt = timestamp(seen, now);
  const occurredAt = timestamp(occurred, now);
  if (!isId(playerId) || !isTag(source) || !isTag(medium) ||
      (campaign !== null && !isTag(campaign)) || (content !== null && !isTag(content)) ||
      typeof existingPlayer !== "boolean" || !firstSeenAt || !occurredAt) return null;
  if (type !== "visit" && type !== "run_started" && type !== "rhythm_12" && type !== "run_completed") return null;
  if (type === "visit" ? runId != null : !isId(runId)) return null;
  return { playerId, firstSeenAt, existingPlayer, source, medium, campaign, content, type,
    runId: isId(runId) ? runId : null, occurredAt: new Date(Math.max(+firstSeenAt, +occurredAt)) };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).end();
  }
  // Previews and local games can share the leaderboard database with production.
  const enabled = process.env.ACQUISITION_TRACKING ?? (process.env.VERCEL_ENV === "production" ? "1" : "0");
  if (enabled !== "1") return res.status(204).end();
  if (req.headers["content-type"]?.split(";")[0].trim() !== "application/json") {
    return res.status(415).end();
  }
  if (req.headers["sec-fetch-site"] === "cross-site") return res.status(403).end();
  const event = parseAcquisitionEvent(req.body);
  if (!event) return res.status(400).json({ error: "Invalid acquisition event" });

  try {
    const { prisma } = await import("./_lib/prisma.js");
    const { playerId, firstSeenAt, existingPlayer, source, medium, campaign, content, runId, type, occurredAt } = event;
    // Each event carries the original first touch so a lost or late visit cannot orphan a run.
    const player = prisma.$executeRaw`
      INSERT INTO acquisition_players (id, first_seen_at, existing_player, source, medium, campaign, content)
      VALUES (${playerId}::uuid, ${firstSeenAt}, ${existingPlayer}, ${source}, ${medium}, ${campaign}, ${content})
      ON CONFLICT (id) DO NOTHING`;
    if (runId) {
      const run = prisma.$executeRaw`
        INSERT INTO acquisition_runs (player_id, run_id, started_at, rhythm_12_at, completed_at)
        VALUES (${playerId}::uuid, ${runId}::uuid,
          ${type === "run_started" ? occurredAt : null}, ${type === "rhythm_12" ? occurredAt : null},
          ${type === "run_completed" ? occurredAt : null})
        ON CONFLICT (player_id, run_id) DO UPDATE SET
          started_at = LEAST(acquisition_runs.started_at, EXCLUDED.started_at),
          rhythm_12_at = LEAST(acquisition_runs.rhythm_12_at, EXCLUDED.rhythm_12_at),
          completed_at = LEAST(acquisition_runs.completed_at, EXCLUDED.completed_at)`;
      await prisma.$transaction([player, run]);
    } else {
      await player;
    }
    return res.status(204).end();
  } catch (error) {
    console.error("[acquisition] write failed", error instanceof Error ? error.name : "unknown error");
    return res.status(503).json({ error: "Acquisition storage unavailable" });
  }
}
