import type { VercelRequest, VercelResponse } from "@vercel/node";
import { prisma } from "./_lib/prisma.js";
import { verifyGoogleToken } from "./_lib/googleAuth.js";
import { toPublicUser } from "./_lib/users.js";

const MAX_NAME_LEN = 16;
const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 10;
// The initial title-screen view scans down the board until the deduped-by-pilot
//   result spans this many distinct score values. Counting deduped survivors
//   (each pilot contributes one row per category) keeps the board full even
//   when one pilot stacks the very top with many distinct-scoring runs.
const TOP_PILOTS_DISTINCT_SCORES = 20;
// Rows pulled per scan batch while accumulating toward the distinct-score
//   target. Capped passes bound the work if scores are extremely sparse.
const TOP_PILOTS_BATCH = 100;
const TOP_PILOTS_MAX_BATCHES = 5;
const TOP_ROWS_CACHE_LIMIT = 100;
// The title screen also pulls the most-recent rows so a "When" sort can surface
//   fresh runs that aren't high enough to be in the top-by-score window.
const RECENT_ROWS_LIMIT = 50;
// The title screen's highlight reel samples from the runs that have a saved
//   replay and reached a real rhythm chain. Bounded so the client can weight the
//   whole pool in one pass; ordered by rhythm so the window holds the runs worth
//   showing rather than the newest ones. The floor is coarse on purpose — the
//   reel's real threshold lives with the reel (src/game/titleReel.ts), which
//   also drops the replays this build can't re-sim, since only the client knows
//   its own format version. Taking either as a query parameter would make this
//   a client-keyed cache over a scan.
const REEL_ROWS_LIMIT = 60;
const REEL_MIN_COMBO = 12;

type KillSummary = Record<string, number>;

type IncomingScore = {
  name?: unknown;
  score?: unknown;
  wave?: unknown;
  max_combo?: unknown;
  kill_count?: unknown;
  kill_summary?: unknown;
  // Optional Google ID token. When present and valid, the row is linked to that
  //   pilot's account and their lifetime stats are bumped. Required to submit
  //   under a callsign someone has claimed.
  idToken?: unknown;
};

type RowOut = {
  id: number;
  name: string;
  score: number;
  wave: number;
  max_combo: number;
  kill_count: number;
  kill_summary: KillSummary;
  has_replay: boolean;
  replay_version: number | null;
  created_at: Date | string;
};

const sanitizeName = (raw: unknown): string | null => {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim().slice(0, MAX_NAME_LEN);
  if (trimmed.length === 0) return null;
  return trimmed;
};

const sanitizeInt = (raw: unknown, min: number, max: number): number | null => {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n)) return null;
  const i = Math.floor(n);
  if (i < min || i > max) return null;
  return i;
};

const sanitizeKillSummary = (raw: unknown): KillSummary => {
  if (!raw || typeof raw !== "object") return {};
  const out: KillSummary = {};
  let kept = 0;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (kept >= 32) break;
    if (typeof k !== "string" || k.length === 0 || k.length > 32) continue;
    const n = typeof v === "number" ? v : Number(v);
    if (!Number.isFinite(n) || n < 0 || n > 1_000_000) continue;
    out[k] = Math.floor(n);
    kept++;
  }
  return out;
};

const toRowOut = (r: {
  id: number;
  name: string;
  score: number;
  wave: number;
  maxCombo: number;
  killCount: number;
  killSummary: unknown;
  replayData?: string | null;
  replayVersion?: number | null;
  createdAt: Date;
}): RowOut => ({
  id: r.id,
  name: r.name,
  score: r.score,
  wave: r.wave,
  max_combo: r.maxCombo,
  kill_count: r.killCount,
  kill_summary: (r.killSummary ?? {}) as KillSummary,
  has_replay: !!r.replayData,
  replay_version: r.replayVersion ?? null,
  created_at: r.createdAt,
});

// Mirrors src/game/scoreEntry.ts dedupeByName: for each pilot, keep best-by-
//   score, best-by-wave, best-by-rhythm; collapse to a single row when one run
//   holds multiple PBs. Dedupes every pilot present in `rows` (the caller bounds
//   the window before calling), which is already sorted by score desc.
const dedupeByPilot = (rows: RowOut[]): RowOut[] => {
  const byPilot = new Map<string, RowOut[]>();
  const pilotOrder: string[] = [];
  for (const row of rows) {
    const key = row.name.toLowerCase();
    let list = byPilot.get(key);
    if (!list) {
      list = [];
      byPilot.set(key, list);
      pilotOrder.push(key);
    }
    list.push(row);
  }
  const keptIds = new Set<number>();
  const out: RowOut[] = [];
  for (const key of pilotOrder) {
    const pilotRows = byPilot.get(key)!;
    const bestScore = pickBest(pilotRows, (a, b) =>
      a.score !== b.score ? a.score > b.score : (a.max_combo ?? 0) > (b.max_combo ?? 0),
    );
    const bestWave = pickBest(pilotRows, (a, b) => {
      const aw = a.wave ?? 0, bw = b.wave ?? 0;
      return aw !== bw ? aw > bw : a.score > b.score;
    });
    const bestRhythm = pickBest(pilotRows, (a, b) => {
      const ac = a.max_combo ?? 0, bc = b.max_combo ?? 0;
      return ac !== bc ? ac > bc : a.score > b.score;
    });
    for (const row of [bestScore, bestWave, bestRhythm]) {
      if (row && !keptIds.has(row.id)) {
        keptIds.add(row.id);
        out.push(row);
      }
    }
  }
  return out;
};

const pickBest = (rows: RowOut[], better: (a: RowOut, b: RowOut) => boolean): RowOut | null => {
  let best: RowOut | null = null;
  for (const row of rows) {
    if (!best || better(row, best)) best = row;
  }
  return best;
};

// Module-level cache survives across warm-invocation reuse on the same
//   serverless instance. Cross-instance staleness is bounded by the edge
//   Cache-Control TTL set on responses below. POSTs clear the local cache so
//   the next read on this instance reflects the new row.
type CacheEntry<T> = { value: T; expires: number };
const CACHE_TTL_MS = 60_000;
let topPilotsCache: CacheEntry<RowOut[]> | null = null;
let topRowsCache: CacheEntry<RowOut[]> | null = null;
let recentRowsCache: CacheEntry<RowOut[]> | null = null;
let reelRowsCache: CacheEntry<RowOut[]> | null = null;

const readCache = <T>(entry: CacheEntry<T> | null): T | null => {
  if (!entry) return null;
  if (entry.expires < Date.now()) return null;
  return entry.value;
};

const invalidateCaches = () => {
  topPilotsCache = null;
  topRowsCache = null;
  recentRowsCache = null;
  reelRowsCache = null;
};

// Leaderboard reads skip the heavy replay_data column and instead return a
//   boolean — the per-row payload would balloon by ~5 KB per replay otherwise.
//   The actual bytes are fetched on demand by /api/replays?id=N.
const LEADERBOARD_COLUMNS = {
  id: true,
  name: true,
  score: true,
  wave: true,
  maxCombo: true,
  killCount: true,
  killSummary: true,
  replayVersion: true,
  createdAt: true,
} as const;

type RawRow = {
  id: number;
  name: string;
  score: number;
  wave: number;
  maxCombo: number;
  killCount: number;
  killSummary: unknown;
  replayVersion: number | null;
  createdAt: Date;
};

const withHasReplay = (rows: RawRow[], hasReplayIds: Set<number>): RowOut[] =>
  rows.map((r) => toRowOut({ ...r, replayData: hasReplayIds.has(r.id) ? "x" : null }));

const fetchHasReplayIds = async (ids: number[]): Promise<Set<number>> => {
  if (ids.length === 0) return new Set();
  const rows = await prisma.highscore.findMany({
    where: { id: { in: ids }, NOT: { replayData: null } },
    select: { id: true },
  });
  return new Set(rows.map((r) => r.id));
};

// has_replay must never be baked into the module caches below. A replay is
//   uploaded a beat AFTER its score row is written, so a cached row carries
//   has_replay: false for the rest of its TTL and the run the pilot just saved
//   renders with no play button. Resolve the flag fresh on every request
//   instead — one indexed lookup over an already-bounded list of ids.
const withFreshReplayFlags = async (rows: RowOut[]): Promise<RowOut[]> => {
  const ids = await fetchHasReplayIds(rows.map((r) => r.id));
  return rows.map((r) => ({ ...r, has_replay: ids.has(r.id) }));
};

const fetchTopPilots = async (): Promise<RowOut[]> => {
  const cached = readCache(topPilotsCache);
  if (cached) return cached;
  // Scan down the board in batches and dedupe-by-pilot the accumulated window
  //   each pass. We stop once the *deduped* rows span enough distinct scores —
  //   counting survivors, not raw rows, so a single pilot stacking the top of
  //   the board (every run a distinct score) doesn't satisfy the target alone.
  const collected: RawRow[] = [];
  let deduped: RowOut[] = [];
  for (let batch = 0; batch < TOP_PILOTS_MAX_BATCHES; batch++) {
    const rows = await prisma.highscore.findMany({
      orderBy: [{ score: "desc" }, { createdAt: "desc" }],
      take: TOP_PILOTS_BATCH,
      skip: batch * TOP_PILOTS_BATCH,
      select: LEADERBOARD_COLUMNS,
    });
    collected.push(...rows);
    // has_replay doesn't affect dedupe, and the caller fills it in fresh.
    deduped = dedupeByPilot(withHasReplay(collected, new Set()));
    const distinctScores = new Set(deduped.map((r) => r.score));
    if (rows.length < TOP_PILOTS_BATCH) break;
    if (distinctScores.size >= TOP_PILOTS_DISTINCT_SCORES) break;
  }
  topPilotsCache = { value: deduped, expires: Date.now() + CACHE_TTL_MS };
  return deduped;
};

const fetchTopRows = async (): Promise<RowOut[]> => {
  const cached = readCache(topRowsCache);
  if (cached) return cached;
  const rows = await prisma.highscore.findMany({
    orderBy: [{ score: "desc" }, { createdAt: "desc" }],
    take: TOP_ROWS_CACHE_LIMIT,
    select: LEADERBOARD_COLUMNS,
  });
  const mapped = withHasReplay(rows, new Set());
  topRowsCache = { value: mapped, expires: Date.now() + CACHE_TTL_MS };
  return mapped;
};

const fetchRecentRows = async (): Promise<RowOut[]> => {
  const cached = readCache(recentRowsCache);
  if (cached) return cached;
  const rows = await prisma.highscore.findMany({
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: RECENT_ROWS_LIMIT,
    select: LEADERBOARD_COLUMNS,
  });
  const mapped = withHasReplay(rows, new Set());
  recentRowsCache = { value: mapped, expires: Date.now() + CACHE_TTL_MS };
  return mapped;
};

// Highlight-reel pool: runs that carry a replay this client can actually re-sim
//   (exact format version) and that reached `minCombo`, best rhythm first. The
//   replay bytes themselves stay behind /api/replays?id=N — this is just the
//   menu the title screen samples from.
const fetchReelRows = async (): Promise<RowOut[]> => {
  const cached = readCache(reelRowsCache);
  if (cached) return cached;
  const rows = await prisma.highscore.findMany({
    where: { maxCombo: { gte: REEL_MIN_COMBO }, NOT: { replayData: null } },
    orderBy: [{ maxCombo: "desc" }, { score: "desc" }],
    take: REEL_ROWS_LIMIT,
    select: LEADERBOARD_COLUMNS,
  });
  // Every row in this query already has replay bytes, so the flag is known true
  //   without the extra lookup withFreshReplayFlags does for the board views —
  //   here the filter *is* the flag. replay_version rides along so the client
  //   can drop what its own build can't re-sim.
  const mapped = withHasReplay(rows, new Set(rows.map((r) => r.id)));
  reelRowsCache = { value: mapped, expires: Date.now() + CACHE_TTL_MS };
  return mapped;
};

// Player-profile view. The initial load (offset 0) gathers the top-N runs in
//   each leaderboard category (score, rhythm, wave, and most-recent) and unions
//   them by id: a pilot whose best-score run differs from their best-wave run
//   keeps both, and the "when" pass folds in fresh runs that aren't a category
//   best. "Load more" then pages the pilot's remaining runs by score-desc — a
//   plain linear cursor past the first PLAYER_CATEGORY_LIMIT score-ranked rows.
//   Case-insensitive name match mirrors the dedupe key used everywhere else.
//   Not cached — it's a rarely-hit per-pilot view.
const PLAYER_CATEGORY_LIMIT = 50;

const playerWhere = (name: string) =>
  ({ name: { equals: name, mode: "insensitive" as const } });

const fetchPlayerScores = async (name: string): Promise<RowOut[]> => {
  const where = playerWhere(name);
  const [byScore, byRhythm, byWave, byRecent] = await Promise.all([
    prisma.highscore.findMany({
      where,
      orderBy: [{ score: "desc" }, { createdAt: "desc" }],
      take: PLAYER_CATEGORY_LIMIT,
      select: LEADERBOARD_COLUMNS,
    }),
    prisma.highscore.findMany({
      where,
      orderBy: [{ maxCombo: "desc" }, { score: "desc" }],
      take: PLAYER_CATEGORY_LIMIT,
      select: LEADERBOARD_COLUMNS,
    }),
    prisma.highscore.findMany({
      where,
      orderBy: [{ wave: "desc" }, { score: "desc" }],
      take: PLAYER_CATEGORY_LIMIT,
      select: LEADERBOARD_COLUMNS,
    }),
    prisma.highscore.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: PLAYER_CATEGORY_LIMIT,
      select: LEADERBOARD_COLUMNS,
    }),
  ]);
  const byId = new Map<number, RawRow>();
  for (const r of [...byScore, ...byRhythm, ...byWave, ...byRecent]) byId.set(r.id, r);
  const merged = [...byId.values()];
  const hasReplayIds = await fetchHasReplayIds(merged.map((r) => r.id));
  return withHasReplay(merged, hasReplayIds);
};

// "Load more" page for a profile: that pilot's runs by score-desc, offset into
//   the score-ranked list. The client dedupes against rows already shown.
const fetchPlayerPage = async (
  name: string,
  offset: number,
  limit: number,
): Promise<RowOut[]> => {
  const rows = await prisma.highscore.findMany({
    where: playerWhere(name),
    orderBy: [{ score: "desc" }, { createdAt: "desc" }],
    take: limit,
    skip: offset,
    select: LEADERBOARD_COLUMNS,
  });
  const hasReplayIds = await fetchHasReplayIds(rows.map((r) => r.id));
  return withHasReplay(rows, hasReplayIds);
};

// Post-run "your standing" view: the rows ranked just above and just below a
//   given score id, under the global [score desc, createdAt desc] ordering.
//   Anchored by id so a tie in score is split deterministically by createdAt,
//   matching the rest of the board. Not cached — it's per-player and one-shot.
const RADIUS_MAX = 25;

const fetchAround = async (
  id: number,
  radius: number,
): Promise<{ scores: RowOut[]; selfRank: number } | null> => {
  const anchor = await prisma.highscore.findUnique({
    where: { id },
    select: LEADERBOARD_COLUMNS,
  });
  if (!anchor) return null;
  // "Above" = strictly higher score, or same score submitted later (later
  //   createdAt sorts first under the desc ordering). Fetch ascending+nearest,
  //   then reverse into top-down display order.
  const abovePredicate = {
    OR: [
      { score: { gt: anchor.score } },
      { score: anchor.score, createdAt: { gt: anchor.createdAt } },
    ],
  };
  const belowPredicate = {
    OR: [
      { score: { lt: anchor.score } },
      { score: anchor.score, createdAt: { lt: anchor.createdAt } },
    ],
  };
  const [aboveAsc, below, aboveCount] = await Promise.all([
    prisma.highscore.findMany({
      where: abovePredicate,
      orderBy: [{ score: "asc" }, { createdAt: "asc" }],
      take: radius,
      select: LEADERBOARD_COLUMNS,
    }),
    prisma.highscore.findMany({
      where: belowPredicate,
      orderBy: [{ score: "desc" }, { createdAt: "desc" }],
      take: radius,
      select: LEADERBOARD_COLUMNS,
    }),
    prisma.highscore.count({ where: abovePredicate }),
  ]);
  const ordered = [...aboveAsc.reverse(), anchor, ...below];
  const hasReplayIds = await fetchHasReplayIds(ordered.map((r) => r.id));
  return { scores: withHasReplay(ordered, hasReplayIds), selfRank: aboveCount + 1 };
};

const setEdgeCache = (res: VercelResponse) => {
  // Short edge cache bounds cross-instance staleness; SWR lets the edge serve
  //   a slightly stale payload while a background revalidation fetches fresh.
  res.setHeader("Cache-Control", "public, s-maxage=10, stale-while-revalidate=60");
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === "GET") {
    const modeRaw = req.query.mode;
    const mode = Array.isArray(modeRaw) ? modeRaw[0] : modeRaw;

    if (mode === "top-pilots") {
      try {
        const rows = await withFreshReplayFlags(await fetchTopPilots());
        setEdgeCache(res);
        res.status(200).json({ scores: rows });
      } catch (err) {
        console.error("[highscores GET top-pilots] db read failed:", err);
        res.status(500).json({ error: "DB read failed" });
      }
      return;
    }

    if (mode === "recent") {
      try {
        const rows = await withFreshReplayFlags(await fetchRecentRows());
        setEdgeCache(res);
        res.status(200).json({ scores: rows });
      } catch (err) {
        console.error("[highscores GET recent] db read failed:", err);
        res.status(500).json({ error: "DB read failed" });
      }
      return;
    }

    if (mode === "reel") {
      try {
        const rows = await fetchReelRows();
        setEdgeCache(res);
        res.status(200).json({ scores: rows });
      } catch (err) {
        console.error("[highscores GET reel] db read failed:", err);
        res.status(500).json({ error: "DB read failed" });
      }
      return;
    }

    if (mode === "player") {
      const nameRaw = req.query.name;
      const name = sanitizeName(Array.isArray(nameRaw) ? nameRaw[0] : nameRaw);
      if (!name) {
        res.status(400).json({ error: "name is required" });
        return;
      }
      // offset 0 (or absent) → the 4-category union; offset > 0 → a score-desc
      //   "load more" page. limit only applies to the paged form.
      const offsetRaw = req.query.offset;
      const limitRaw = req.query.limit;
      const offset = sanitizeInt(Array.isArray(offsetRaw) ? offsetRaw[0] : offsetRaw, 0, 1_000_000) ?? 0;
      const limit = sanitizeInt(Array.isArray(limitRaw) ? limitRaw[0] : limitRaw, 1, MAX_LIMIT) ?? PLAYER_CATEGORY_LIMIT;
      try {
        const rows = offset > 0
          ? await fetchPlayerPage(name, offset, limit)
          : await fetchPlayerScores(name);
        // Only the initial (offset 0) load carries the profile banner — if this
        //   callsign is claimed, hand back its owner's lifetime stats. Paged
        //   "load more" requests skip the extra lookup.
        let user = null;
        if (offset === 0) {
          const owner = await prisma.user.findUnique({
            where: { usernameLower: name.toLowerCase() },
          });
          if (owner && owner.username) user = toPublicUser(owner);
        }
        setEdgeCache(res);
        res.status(200).json({ scores: rows, user });
      } catch (err) {
        console.error("[highscores GET player] db read failed:", err);
        res.status(500).json({ error: "DB read failed" });
      }
      return;
    }

    if (mode === "around") {
      const idRaw = req.query.id;
      const radiusRaw = req.query.radius;
      const id = sanitizeInt(Array.isArray(idRaw) ? idRaw[0] : idRaw, 1, Number.MAX_SAFE_INTEGER);
      const radius = sanitizeInt(Array.isArray(radiusRaw) ? radiusRaw[0] : radiusRaw, 1, RADIUS_MAX) ?? RADIUS_MAX;
      if (id === null) {
        res.status(400).json({ error: "id is required" });
        return;
      }
      try {
        const result = await fetchAround(id, radius);
        if (!result) {
          res.status(404).json({ error: "score not found" });
          return;
        }
        res.setHeader("Cache-Control", "no-store");
        res.status(200).json(result);
      } catch (err) {
        console.error("[highscores GET around] db read failed:", err);
        res.status(500).json({ error: "DB read failed" });
      }
      return;
    }

    const limitRaw = req.query.limit;
    const offsetRaw = req.query.offset;
    const requested = sanitizeInt(Array.isArray(limitRaw) ? limitRaw[0] : limitRaw, 1, MAX_LIMIT);
    const limit = requested ?? DEFAULT_LIMIT;
    const offset = sanitizeInt(Array.isArray(offsetRaw) ? offsetRaw[0] : offsetRaw, 0, 1_000_000) ?? 0;

    // The hot read path is "first page, no offset" — that's what gets cached.
    //   Paged reads past the cache window fall through to a direct DB query.
    if (offset === 0 && limit <= TOP_ROWS_CACHE_LIMIT) {
      try {
        const rows = await withFreshReplayFlags((await fetchTopRows()).slice(0, limit));
        setEdgeCache(res);
        res.status(200).json({ scores: rows });
      } catch (err) {
        console.error("[highscores GET] db read failed:", err);
        res.status(500).json({ error: "DB read failed" });
      }
      return;
    }

    try {
      const rows = await prisma.highscore.findMany({
        orderBy: [{ score: "desc" }, { createdAt: "desc" }],
        take: limit,
        skip: offset,
        select: LEADERBOARD_COLUMNS,
      });
      const hasReplayIds = await fetchHasReplayIds(rows.map((r) => r.id));
      res.setHeader("Cache-Control", "no-store");
      res.status(200).json({ scores: withHasReplay(rows, hasReplayIds) });
    } catch (err) {
      console.error("[highscores GET] db read failed:", err);
      res.status(500).json({ error: "DB read failed" });
    }
    return;
  }

  if (req.method === "POST") {
    const body = (req.body ?? {}) as IncomingScore;
    const name = sanitizeName(body.name);
    const score = sanitizeInt(body.score, 0, 1_000_000_000);
    const wave = sanitizeInt(body.wave, 1, 10_000) ?? 1;
    const maxCombo = sanitizeInt(body.max_combo, 0, 1_000_000) ?? 0;
    const killCount = sanitizeInt(body.kill_count, 0, 1_000_000) ?? 0;
    const killSummary = sanitizeKillSummary(body.kill_summary);
    if (!name || score === null) {
      res.status(400).json({ error: "name and score are required" });
      return;
    }
    try {
      // Resolve the submitter's account (if they sent a valid Google token) and
      //   whoever, if anyone, owns this callsign.
      const identity = await verifyGoogleToken(body.idToken);
      const authedUser = identity
        ? await prisma.user.findUnique({ where: { googleSub: identity.sub } })
        : null;
      const claimOwner = await prisma.user.findUnique({
        where: { usernameLower: name.toLowerCase() },
      });
      // A claimed callsign can only be used by its owner. Unclaimed names stay
      //   open to anyone (guest play is unchanged).
      if (claimOwner && (!authedUser || authedUser.id !== claimOwner.id)) {
        res.status(403).json({
          error: "That callsign is claimed. Sign in with Google to submit under it.",
        });
        return;
      }

      const row = await prisma.highscore.create({
        data: { name, score, wave, maxCombo, killCount, killSummary, userId: authedUser?.id ?? null },
      });

      // Bump the signed-in pilot's lifetime stats. Non-fatal: the score is
      //   already saved, so a stats hiccup shouldn't fail the submission.
      let publicUser = null;
      if (authedUser) {
        try {
          const updated = await prisma.user.update({
            where: { id: authedUser.id },
            data: {
              gamesPlayed: { increment: 1 },
              totalKills: { increment: killCount },
              totalScore: { increment: BigInt(score) },
              lastPlayedAt: new Date(),
              ...(score > authedUser.bestScore ? { bestScore: score } : {}),
              ...(wave > authedUser.bestWave ? { bestWave: wave } : {}),
              ...(maxCombo > authedUser.bestCombo ? { bestCombo: maxCombo } : {}),
            },
          });
          publicUser = toPublicUser(updated);
        } catch (statErr) {
          console.error("[highscores POST] stat bump failed:", statErr);
        }
      }
      // Clear local cache so the next read on this instance reflects the new
      //   row. Other warm instances still serve their cached payload until
      //   their TTL expires or they receive their own POST.
      invalidateCaches();
      // Warm both caches in the background so the next GET on this instance
      //   doesn't pay the DB round-trip. Errors here are non-fatal.
      void fetchTopPilots().catch((err) =>
        console.error("[highscores POST] cache warm top-pilots failed:", err),
      );
      void fetchTopRows().catch((err) =>
        console.error("[highscores POST] cache warm top-rows failed:", err),
      );
      void fetchRecentRows().catch((err) =>
        console.error("[highscores POST] cache warm recent failed:", err),
      );
      res.status(201).json({ score: toRowOut(row), user: publicUser });
    } catch (err) {
      console.error("[highscores POST] db write failed:", err);
      res.status(500).json({ error: "DB write failed" });
    }
    return;
  }

  res.setHeader("Allow", "GET, POST");
  res.status(405).json({ error: "Method not allowed" });
}
