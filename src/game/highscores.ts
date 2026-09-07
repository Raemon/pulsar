import type { Game } from "../Game";
import type { KillBucket } from "./killBuckets";
import { displayWave } from "./waveDirector";
import { getIdToken, type PublicUser } from "./auth";
import { REPLAY_FORMAT_VERSION } from "./replayFormat";

// bucket names are emitted by killEffects.ts; this label map keeps the
// leaderboard summary readable instead of leaking internal asteroid kinds.
const BUCKET_LABELS: Record<KillBucket, string> = {
  asteroid_huge: "2xL",
  asteroid_large: "lg",
  asteroid_medium: "md",
  asteroid_small: "sm",
  bassteroid: "bass",
  chime: "chime",
  bell: "bell",
  warble: "warble",
  citadel: "citadel",
  asteroidWithGem: "gem",
  burstGem: "gold gem",
  solidCrystal: "crystal",
  metalChunk: "metal",
  alien_big: "alien-L",
  alien_medium: "alien-M",
  alien_small: "alien-S",
  comet: "comet",
  boss: "boss",
  sepulchre: "sepulchre",
  glassPrison: "prison",
  wraith: "wraith",
};

export type HighscoreRow = {
  id: number;
  name: string;
  score: number;
  wave: number;
  max_combo: number;
  kill_count: number;
  kill_summary: Record<string, number>;
  has_replay?: boolean;
  replay_version?: number | null;
  created_at: string;
};

export const totalKills = (tally: Readonly<Record<string, number>>): number => {
  let total = 0;
  for (const n of Object.values(tally)) total += n;
  return total;
};

// Score ids this browser has successfully uploaded a replay for. A replay
//   lands a moment after its score row, so every cache between here and the
//   database — the API's module cache, the CDN's s-maxage window, and our own
//   localStorage snapshot — can still be holding has_replay: false for the run
//   the pilot just saved, and the leaderboard would render it without a play
//   button. This is the one thing that knows better, so it overrides them all.
const SAVED_REPLAY_IDS_KEY = "pulsar.savedReplayIds";
// Bounded so the key can't grow without limit; only recent runs are still
//   young enough for a stale cache to be lying about them.
const SAVED_REPLAY_IDS_MAX = 200;

const readSavedReplayIds = (): number[] => {
  try {
    const raw = localStorage.getItem(SAVED_REPLAY_IDS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((n): n is number => typeof n === "number");
  } catch {
    return [];
  }
};

let savedReplayIds = new Set<number>(readSavedReplayIds());

export const markReplaySaved = (id: number) => {
  savedReplayIds.add(id);
  try {
    const kept = [...savedReplayIds].slice(-SAVED_REPLAY_IDS_MAX);
    savedReplayIds = new Set(kept);
    localStorage.setItem(SAVED_REPLAY_IDS_KEY, JSON.stringify(kept));
  } catch {
    // localStorage may be blocked; the in-session set still covers this visit.
  }
};

// Force the replay flag true on rows we know we uploaded. replay_version is
//   filled in too: we recorded it on this build, so a null from a stale cache
//   would otherwise be indistinguishable from a legacy row and the button
//   would render without the version it needs.
const applyKnownReplays = (rows: HighscoreRow[]): HighscoreRow[] => {
  if (savedReplayIds.size === 0) return rows;
  return rows.map((row) =>
    savedReplayIds.has(row.id)
      ? { ...row, has_replay: true, replay_version: row.replay_version ?? REPLAY_FORMAT_VERSION }
      : row,
  );
};

export type SubmitResult = { score: HighscoreRow; user: PublicUser | null };

export const submitHighscore = async (
  name: string,
  game: Game,
): Promise<SubmitResult> => {
  // Read the frozen game-over snapshot when present: the highlight clip re-sims
  //   the run on the live game object, so game.score/maxCombo/killTally now hold
  //   the clip's in-progress values, not the finished run's. runSummary is the
  //   run as it ended.
  const s = game.runSummary;
  // Attach the Google ID token when signed in — the server links the row to the
  //   pilot's account, bumps their stats, and permits submitting under a claimed
  //   callsign. Omitted (undefined → absent) for guest submissions.
  const idToken = getIdToken() ?? undefined;
  const res = await fetch("/api/highscores", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name,
      score: s ? s.score : game.score,
      wave: displayWave(s ? s.wave : game.wave),
      max_combo: s ? s.maxCombo : game.maxCombo,
      kill_count: totalKills(s ? s.killTally : game.killTally),
      kill_summary: s ? s.killTally : game.killTally,
      idToken,
    }),
  });
  if (!res.ok) {
    // Surface the server's message for the claimed-callsign (403) case so the
    //   player understands why the save was refused.
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    if (res.status === 403 && body?.error) throw new Error(body.error);
    throw new Error(`submit failed: ${res.status} ${body?.error ?? ""}`.trim());
  }
  const body = (await res.json()) as SubmitResult;
  return body;
};

// no-store so a plain reload always reflects fresh server data — the API sends
//   a `public` Cache-Control for the edge, which the browser would otherwise
//   honour and replay a stale leaderboard on the next visit.
export const fetchHighscores = async (limit = 10, offset = 0): Promise<HighscoreRow[]> => {
  const url = `/api/highscores?limit=${limit}&offset=${offset}`;
  const res = await fetch(url, { method: "GET", cache: "no-store" });
  if (!res.ok) throw new Error(`fetch failed: ${res.status}`);
  const body = (await res.json()) as { scores: HighscoreRow[] };
  return applyKnownReplays(body.scores);
};

// Server-side deduped "top N pilots" view — the initial title-screen payload.
//   The server runs the same per-pilot best-of-category logic the client used
//   to apply locally, so this returns far fewer rows than the raw top-100.
export const fetchTopPilots = async (): Promise<HighscoreRow[]> => {
  const res = await fetch("/api/highscores?mode=top-pilots", { method: "GET", cache: "no-store" });
  if (!res.ok) throw new Error(`fetch failed: ${res.status}`);
  const body = (await res.json()) as { scores: HighscoreRow[] };
  return applyKnownReplays(body.scores);
};

// The most-recent rows, regardless of score. Folded into the title-screen pool
//   so a fresh run shows up by default only if it's a pilot's category best,
//   but is always reachable by sorting on the "When" column.
export const fetchRecentScores = async (): Promise<HighscoreRow[]> => {
  const res = await fetch("/api/highscores?mode=recent", { method: "GET", cache: "no-store" });
  if (!res.ok) throw new Error(`fetch failed: ${res.status}`);
  const body = (await res.json()) as { scores: HighscoreRow[] };
  return applyKnownReplays(body.scores);
};

// Player-profile view: every run by one pilot, server-gathered as the top-50 in
//   each category (score, rhythm, wave, most-recent) and unioned. The view
//   renders these unfiltered (no per-pilot dedupe) so the player sees their
//   full board.
export type PlayerProfile = { scores: HighscoreRow[]; user: PublicUser | null };

export const fetchPlayerScores = async (name: string): Promise<PlayerProfile> => {
  const res = await fetch(`/api/highscores?mode=player&name=${encodeURIComponent(name)}`, {
    method: "GET",
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`fetch failed: ${res.status}`);
  const body = (await res.json()) as { scores: HighscoreRow[]; user?: PublicUser | null };
  return { scores: applyKnownReplays(body.scores), user: body.user ?? null };
};

// "Load more" for a profile: that pilot's next page of runs by score-desc, past
//   the score-ranked rows already shown. Deduped against the loaded set by the
//   caller; an offset of 0 would re-fetch the union, so callers pass offset > 0.
export const fetchPlayerPage = async (
  name: string,
  offset: number,
  limit = 50,
): Promise<HighscoreRow[]> => {
  const url = `/api/highscores?mode=player&name=${encodeURIComponent(name)}&offset=${offset}&limit=${limit}`;
  const res = await fetch(url, { method: "GET", cache: "no-store" });
  if (!res.ok) throw new Error(`fetch failed: ${res.status}`);
  const body = (await res.json()) as { scores: HighscoreRow[] };
  return applyKnownReplays(body.scores);
};

// Post-run "your standing": the rows ranked just above and below the player's
//   submitted score, with selfRank giving the score's true global position so
//   the leaderboard can show real rank numbers instead of a window-local index.
export const fetchNeighborhood = async (
  id: number,
  radius = 25,
): Promise<{ scores: HighscoreRow[]; selfRank: number }> => {
  const res = await fetch(`/api/highscores?mode=around&id=${id}&radius=${radius}`, {
    method: "GET",
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`fetch failed: ${res.status}`);
  const body = (await res.json()) as { scores: HighscoreRow[]; selfRank: number };
  return { scores: applyKnownReplays(body.scores), selfRank: body.selfRank };
};

// the leaderboard row shows a compressed kill breakdown; pick the top few
// buckets so the row stays scannable instead of dumping every category.
export const formatKillSummary = (summary: Record<string, number>): string => {
  const entries = Object.entries(summary ?? {});
  if (entries.length === 0) return "";
  entries.sort((a, b) => b[1] - a[1]);
  const parts: string[] = [];
  for (const [bucket, count] of entries.slice(0, 4)) {
    const label = BUCKET_LABELS[bucket as KillBucket] ?? bucket;
    parts.push(`${count}${label}`);
  }
  return parts.join(" · ");
};

const RECENT_NAME_KEY = "pulsar.recentName";

export const getRecentName = (): string => {
  try {
    return localStorage.getItem(RECENT_NAME_KEY) ?? "";
  } catch {
    return "";
  }
};

export const saveRecentName = (name: string) => {
  try {
    localStorage.setItem(RECENT_NAME_KEY, name);
  } catch {
    // localStorage may be blocked (private mode); the leaderboard still works without it.
  }
};

// Cached top-50 from the last fetch so the title screen renders instantly on
// reload while the network call refreshes in the background.
const CACHED_ROWS_KEY = "pulsar.leaderboardCache";

export const getCachedHighscores = (): HighscoreRow[] => {
  try {
    const raw = localStorage.getItem(CACHED_ROWS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return applyKnownReplays(parsed as HighscoreRow[]);
  } catch {
    return [];
  }
};

export const saveCachedHighscores = (rows: HighscoreRow[]) => {
  try {
    localStorage.setItem(CACHED_ROWS_KEY, JSON.stringify(rows));
  } catch {
    // localStorage may be blocked (private mode); leaderboard still works without cache.
  }
};

// Every fresh page load defaults the leaderboard to "top entries only" so
//   first impressions show one row per pilot. The toggle still flips it
//   within a session, but it is not persisted across reloads.
export const getTopEntriesOnly = (): boolean => true;

export const saveTopEntriesOnly = (_on: boolean) => {
  // Intentionally no-op — see getTopEntriesOnly for the rationale.
};

const REPLAY_OPT_IN_KEY = "pulsar.saveReplay";

// Default on so the replay-saving behaviour is discoverable on a first run.
export const getSaveReplayPref = (): boolean => {
  try {
    const raw = localStorage.getItem(REPLAY_OPT_IN_KEY);
    if (raw === null) return true;
    return raw === "1";
  } catch {
    return true;
  }
};

export const saveSaveReplayPref = (on: boolean) => {
  try {
    localStorage.setItem(REPLAY_OPT_IN_KEY, on ? "1" : "0");
  } catch {
    // localStorage may be blocked; the in-session checkbox state still works.
  }
};
