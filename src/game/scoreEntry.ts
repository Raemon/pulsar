import type { Game } from "../Game";
import {
  fetchHighscores,
  fetchNeighborhood,
  fetchPlayerPage,
  fetchPlayerScores,
  fetchRecentScores,
  fetchTopPilots,
  getCachedHighscores,
  getRecentName,
  getSaveReplayPref,
  getTopEntriesOnly,
  markReplaySaved,
  saveCachedHighscores,
  saveRecentName,
  saveSaveReplayPref,
  saveTopEntriesOnly,
  submitHighscore,
  type HighscoreRow,
} from "./highscores";
import { uploadReplay, fetchReplay } from "./replayApi";
import { REPLAY_FORMAT_VERSION, UnsupportedReplayVersionError } from "./replayFormat";
import { startReplay } from "./lifecycle";
import {
  claimUsername,
  currentUser,
  isAuthAvailable,
  isSignedIn,
  onAuthChange,
  renderSignInButton,
  signOut,
  type PublicUser,
} from "./auth";

// one module owns the score-entry form + leaderboard so lifecycle.ts and
// gameUpdate.ts don't have to know about DOM details or network state.

const setStatus = (game: Game, msg: string, kind: "info" | "error" | "success" = "info") => {
  // "press enter" refers to the key — render the key name white so it pops
  //   against the tinted status text.
  const keyMatch = msg.match(/^(.*press )(enter)(.*)$/i);
  if (keyMatch) {
    const keyEl = document.createElement("span");
    keyEl.className = "status-key";
    keyEl.textContent = keyMatch[2];
    game.scoreEntryStatusEl.textContent = "";
    game.scoreEntryStatusEl.append(keyMatch[1], keyEl, keyMatch[3]);
  } else {
    game.scoreEntryStatusEl.textContent = msg;
  }
  game.scoreEntryStatusEl.classList.remove("error", "success");
  if (kind === "error") game.scoreEntryStatusEl.classList.add("error");
  else if (kind === "success") game.scoreEntryStatusEl.classList.add("success");
};

const handleSubmit = async (game: Game, ev: Event) => {
  ev.preventDefault();
  if (game.scoreSubmitState !== "idle") return;
  const rawName = game.scoreEntryInputEl.value.trim();
  if (!rawName) {
    setStatus(game, "Enter a name to save your score.", "error");
    return;
  }
  const wantReplay = game.replaySaveCheckboxEl.checked;
  game.scoreSubmitState = "submitting";
  game.scoreEntrySubmitEl.disabled = true;
  game.scoreEntryInputEl.disabled = true;
  game.replaySaveCheckboxEl.disabled = true;
  setStatus(game, "Transmitting…", "info");
  try {
    const result = await submitHighscore(rawName, game);
    const saved = result.score;
    saveRecentName(rawName);
    game.lastRunScoreId = saved.id;
    game.lastRunScore = saved.score;
    // Signed-in submit came back with refreshed lifetime stats — show them
    //   under the form so the pilot sees their totals tick up.
    if (result.user) renderSubmitStats(result.user);
    game.scoreEntryInputEl.blur();
    if (wantReplay) {
      setStatus(game, "Uploading replay…", "info");
      try {
        const bytes = await waitForReplayBytes(game);
        if (!bytes) {
          setStatus(game, "Score saved. Replay unavailable. Press enter to continue.", "success");
        } else {
          await uploadReplay(saved.id, rawName, bytes);
          markReplaySaved(saved.id);
          setStatus(game, "Score + replay saved. Press enter to continue.", "success");
        }
      } catch (err) {
        setStatus(game, `Score saved (replay upload failed: ${(err as Error).message}). Press enter to continue.`, "error");
      }
    } else {
      setStatus(game, "Score saved. Press enter to continue.", "success");
    }
    // Arm the one-shot "your standing" view and pre-fetch its rows, so returning
    //   home renders the centred neighborhood without a loading flash. Fetched
    //   AFTER the replay upload, not before.
    game.showNeighborhoodOnce = true;
    game.neighborhoodFetch = fetchNeighborhood(saved.id, 25).catch(() => null);
    game.scoreSubmitState = "submitted";
  } catch (err) {
    game.scoreSubmitState = "idle";
    game.scoreEntrySubmitEl.disabled = false;
    game.scoreEntryInputEl.disabled = false;
    game.replaySaveCheckboxEl.disabled = false;
    setStatus(game, `Save failed: ${(err as Error).message}`, "error");
  }
};

// the Enter key normally restarts the game from the gameover screen, but
// while the input is focused we want it to submit the form instead. Escape
// dismisses the form so the player can press Enter to skip submission and
// restart without typing a name.
const handleInputKeydown = (game: Game, ev: KeyboardEvent) => {
  if (ev.key === "Enter") {
    ev.stopPropagation();
    // During a highlight clip game.input is the replay shim and the window
    //   keydown is swallowed here, so mirror the press onto the live input —
    //   tickHighlightGameOverInput reads it for Enter-to-continue.
    if (game.highlightClip) game.localInput.setVirtual("enter", true);
    return;
  }
  if (ev.key === "Escape") {
    ev.stopPropagation();
    ev.preventDefault();
    hideScoreEntry(game);
    if (game.highlightClip) game.localInput.setVirtual("escape", true);
  }
};

let listenersBound = false;

const bindListeners = (game: Game) => {
  if (listenersBound) return;
  listenersBound = true;
  game.scoreEntryFormEl.addEventListener("submit", (ev) => void handleSubmit(game, ev));
  game.scoreEntryInputEl.addEventListener("keydown", (ev) => handleInputKeydown(game, ev));
  game.replaySaveCheckboxEl.addEventListener("change", () => {
    saveSaveReplayPref(game.replaySaveCheckboxEl.checked);
  });
};

export const showScoreEntry = (game: Game) => {
  bindListeners(game);
  bindAuthUi(game);
  // ram-only or otherwise score-less runs shouldn't pester for a name —
  // there's nothing meaningful to record. Prefer the frozen run summary: a
  // running highlight clip has reset live game.score to its re-sim value.
  const finalScore = game.runSummary ? game.runSummary.score : game.score;
  if (finalScore <= 0) {
    game.scoreEntryFormEl.classList.add("hidden");
    return;
  }
  game.scoreSubmitState = "idle";
  game.scoreEntryInputEl.disabled = false;
  game.scoreEntrySubmitEl.disabled = false;
  game.replaySaveCheckboxEl.disabled = false;
  game.replaySaveCheckboxEl.checked = getSaveReplayPref();
  game.scoreEntryInputEl.value = getRecentName();
  hideSubmitStats();
  setStatus(game, "Esc to skip", "info");
  game.scoreEntryFormEl.classList.remove("hidden");
  // Paint the sign-in / claim controls (may lock the input to a claimed
  //   callsign). Safe no-op when Google sign-in isn't configured.
  syncScoreEntryAuth(game);
  // Defer focus so the overlay reveal animation doesn't fight the input.
  setTimeout(() => {
    if (!game.scoreEntryFormEl.classList.contains("hidden")) game.scoreEntryInputEl.focus();
  }, 60);
};

export const hideScoreEntry = (game: Game) => {
  game.scoreEntryFormEl.classList.add("hidden");
  game.scoreEntryInputEl.blur();
  hideSubmitStats();
};

// ---- Google sign-in / callsign claim UI ----
// The score-entry form gains a sign-in area (#score-entry-auth) and an
//   after-submit stats line (#score-entry-stats). Everything degrades to a
//   plain guest form when VITE_GOOGLE_CLIENT_ID is unset (isAuthAvailable()).

const fmt = (n: number) => n.toLocaleString();

let authBound = false;

const bindAuthUi = (game: Game) => {
  if (authBound) return;
  authBound = true;
  const area = document.getElementById("score-entry-auth");
  if (!area) return;
  // Controls are re-rendered on every state change, so delegate their clicks.
  area.addEventListener("click", (ev) => {
    const el = ev.target as HTMLElement | null;
    if (!el) return;
    if (el.closest("[data-auth-signout]")) {
      ev.preventDefault();
      ev.stopPropagation();
      signOut();
      return;
    }
    if (el.closest("[data-auth-claim]")) {
      ev.preventDefault();
      ev.stopPropagation();
      void handleClaim(game);
    }
  });
  // Re-sync when auth flips (a sign-in resolves, a claim lands) while visible.
  onAuthChange(() => {
    if (!game.scoreEntryFormEl.classList.contains("hidden")) syncScoreEntryAuth(game);
  });
};

const handleClaim = async (game: Game) => {
  const desired = game.scoreEntryInputEl.value.trim();
  if (!desired) {
    setStatus(game, "Type a callsign to claim.", "error");
    return;
  }
  setStatus(game, "Claiming callsign…", "info");
  try {
    const user = await claimUsername(desired);
    saveRecentName(user.username ?? desired);
    setStatus(game, `Callsign "${user.username}" is yours. Press enter to save.`, "success");
    syncScoreEntryAuth(game);
  } catch (err) {
    setStatus(game, (err as Error).message, "error");
  }
};

// Render the sign-in / claim controls for the current auth state.
const syncScoreEntryAuth = (game: Game) => {
  const area = document.getElementById("score-entry-auth");
  if (!area) return;
  if (!isAuthAvailable()) {
    area.classList.add("hidden");
    return;
  }
  area.classList.remove("hidden");

  if (!isSignedIn()) {
    game.scoreEntryInputEl.readOnly = false;
    area.innerHTML =
      `<span class="auth-hint">Claim your callsign so no one else can use it:</span>` +
      `<div id="score-entry-google-btn" class="auth-google-btn"></div>`;
    const btn = document.getElementById("score-entry-google-btn");
    if (btn) void renderSignInButton(btn);
    return;
  }

  const user = currentUser();
  const claimed = user?.username ?? null;
  if (claimed) {
    // Locked to the claimed callsign — that's the identity they submit under.
    game.scoreEntryInputEl.value = claimed;
    game.scoreEntryInputEl.readOnly = true;
    area.innerHTML =
      `<span class="auth-signed">Playing as <strong>${escapeHtml(claimed)}</strong> ` +
      `<span class="auth-check">✓ claimed</span></span>` +
      `<button type="button" class="auth-link" data-auth-signout>sign out</button>`;
  } else {
    game.scoreEntryInputEl.readOnly = false;
    const who = user?.displayName ? escapeHtml(user.displayName) : "Google";
    area.innerHTML =
      `<span class="auth-signed">Signed in as ${who}</span>` +
      `<button type="button" class="auth-link auth-claim-btn" data-auth-claim>Claim this callsign</button>` +
      `<button type="button" class="auth-link" data-auth-signout>sign out</button>`;
  }
};

const renderSubmitStats = (user: PublicUser) => {
  const el = document.getElementById("score-entry-stats");
  if (!el) return;
  const s = user.stats;
  const who = user.username ? `${user.username}: ` : "";
  el.textContent =
    `★ ${who}${fmt(s.gamesPlayed)} run${s.gamesPlayed === 1 ? "" : "s"} · ` +
    `best ${fmt(s.bestScore)} · wave ${fmt(s.bestWave)} · ${fmt(s.bestCombo)}× combo`;
  el.classList.remove("hidden");
};

const hideSubmitStats = () => {
  const el = document.getElementById("score-entry-stats");
  if (el) {
    el.classList.add("hidden");
    el.textContent = "";
  }
};

// ---- Pilot-profile stats banner ----

const statCell = (label: string, value: string) =>
  `<div class="pilot-stat"><span class="pilot-stat-value">${escapeHtml(value)}</span>` +
  `<span class="pilot-stat-label">${escapeHtml(label)}</span></div>`;

const formatMemberSince = (iso: string): string => {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  return new Date(t).toLocaleDateString(undefined, { year: "numeric", month: "short" });
};

// Show the claimed-pilot banner above the profile board, or hide it (guest
//   pilots / other views pass null).
const renderProfileBanner = (user: PublicUser | null) => {
  const el = document.getElementById("leaderboard-profile-banner");
  if (!el) return;
  if (!user || !user.username) {
    el.classList.add("hidden");
    el.innerHTML = "";
    return;
  }
  const s = user.stats;
  const avatar = user.picture
    ? `<img class="pilot-avatar" src="${escapeHtml(user.picture)}" alt="" referrerpolicy="no-referrer" />`
    : `<div class="pilot-avatar pilot-avatar-fallback">${escapeHtml((user.username[0] ?? "?").toUpperCase())}</div>`;
  el.innerHTML =
    `<div class="pilot-banner-head">${avatar}` +
    `<div class="pilot-banner-id"><span class="pilot-banner-name">${escapeHtml(user.username)}</span>` +
    `<span class="pilot-banner-badge">✓ claimed pilot</span></div></div>` +
    `<div class="pilot-banner-stats">` +
    statCell("Runs", fmt(s.gamesPlayed)) +
    statCell("Best score", fmt(s.bestScore)) +
    statCell("Best wave", fmt(s.bestWave)) +
    statCell("Best combo", `${fmt(s.bestCombo)}×`) +
    statCell("Total kills", fmt(s.totalKills)) +
    statCell("Member since", formatMemberSince(user.memberSince)) +
    `</div>`;
  el.classList.remove("hidden");
};

// captureFrame fires in the update loop and serialize() is awaited inside
//   finalizeRecorder — by the time the player has typed a name + hit Enter,
//   the bytes are typically already on game.lastRunReplay. A short poll
//   covers the edge case where submit lands within the first frame after
//   gameover. The window is generous because a long run gzips several MB of
//   JSON on a main thread that's also driving the game-over highlight clip —
//   the loop exits the moment the bytes land, so the wait costs nothing when
//   they're already there.
const waitForReplayBytes = async (game: Game, timeoutMs = 15000): Promise<Uint8Array | null> => {
  const start = performance.now();
  while (!game.lastRunReplay && performance.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 50));
  }
  return game.lastRunReplay;
};

// scoreSubmitState gates whether Enter restarts the game — we want the
// player to confirm the save (or see the error) before bouncing back to title.
export const isScoreEntryBlockingEnter = (game: Game): boolean => {
  if (game.scoreEntryFormEl.classList.contains("hidden")) return false;
  return game.scoreSubmitState !== "submitted";
};

// "Rhythm" column sort: max combo first, score as tiebreaker.
const sortByComboThenScore = (rows: HighscoreRow[]): HighscoreRow[] =>
  [...rows].sort((a, b) => {
    const comboDiff = (b.max_combo ?? 0) - (a.max_combo ?? 0);
    if (comboDiff !== 0) return comboDiff;
    return b.score - a.score;
  });

const sortByScore = (rows: HighscoreRow[]): HighscoreRow[] =>
  [...rows].sort((a, b) => {
    const scoreDiff = b.score - a.score;
    if (scoreDiff !== 0) return scoreDiff;
    return (b.max_combo ?? 0) - (a.max_combo ?? 0);
  });

const sortByWave = (rows: HighscoreRow[]): HighscoreRow[] =>
  [...rows].sort((a, b) => {
    const waveDiff = (b.wave ?? 0) - (a.wave ?? 0);
    if (waveDiff !== 0) return waveDiff;
    return b.score - a.score;
  });

const sortByName = (rows: HighscoreRow[]): HighscoreRow[] =>
  [...rows].sort((a, b) => {
    const nameDiff = a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    if (nameDiff !== 0) return nameDiff;
    return b.score - a.score;
  });

const rowEpoch = (r: HighscoreRow): number => {
  const t = Date.parse(r.created_at ?? "");
  return Number.isFinite(t) ? t : 0;
};

const sortByDate = (rows: HighscoreRow[]): HighscoreRow[] =>
  [...rows].sort((a, b) => {
    const dateDiff = rowEpoch(b) - rowEpoch(a);
    if (dateDiff !== 0) return dateDiff;
    return b.score - a.score;
  });

const sortRows = (rows: HighscoreRow[], key: Game["leaderboardSort"]): HighscoreRow[] => {
  switch (key) {
    case "score": return sortByScore(rows);
    case "wave": return sortByWave(rows);
    case "name": return sortByName(rows);
    case "date": return sortByDate(rows);
    case "rhythm":
    default: return sortByComboThenScore(rows);
  }
};

// Absolute date for the leaderboard tooltip: "Mar 5, 2026 · 14:32".
const formatExactDate = (iso: string | undefined): string => {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const d = new Date(t);
  const date = d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  const time = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  return `${date} · ${time}`;
};

// Compact relative-time formatter for the leaderboard date column: 5m, 1d, 1w, 1mo, 2y.
const formatFromNow = (iso: string | undefined): string => {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const sec = Math.max(0, (Date.now() - t) / 1000);
  if (sec < 60) return `${Math.floor(sec)}s`;
  const min = sec / 60;
  if (min < 60) return `${Math.floor(min)}m`;
  const hr = min / 60;
  if (hr < 24) return `${Math.floor(hr)}h`;
  const day = hr / 24;
  if (day < 7) return `${Math.floor(day)}d`;
  const week = day / 7;
  if (week < 5) return `${Math.floor(week)}w`;
  const month = day / 30;
  if (month < 12) return `${Math.floor(month)}mo`;
  return `${Math.floor(day / 365)}y`;
};

// gameover "Your Standing" view: 51-row window (25 above + selected + 25 below).
// title screen: 7-row window so the opening reads as a hall of fame but arrows
//   still scroll through the full top-50.
const GAMEOVER_WINDOW_SIZE = 51;
const TITLE_WINDOW_SIZE = 7;

const visibleWindowSize = (game: Game): number =>
  game.lastRunScoreId !== null ? GAMEOVER_WINDOW_SIZE : TITLE_WINDOW_SIZE;

// Window anchor that keeps the selection centred when possible, but clamps
//   against the list boundaries so we never show empty slots above the #1 row
//   or below the last row.
const windowStart = (selection: number, total: number, size: number): number => {
  if (total <= size) return 0;
  const radius = (size - 1) >> 1;
  const ideal = selection - radius;
  const maxStart = total - size;
  return Math.max(0, Math.min(maxStart, ideal));
};

type ReplayBuildMismatch = "older" | "newer" | null;

const replayBuildMismatch = (row: HighscoreRow): ReplayBuildMismatch => {
  const v = row.replay_version;
  if (typeof v !== "number" || v === REPLAY_FORMAT_VERSION) return null;
  return v < REPLAY_FORMAT_VERSION ? "older" : "newer";
};

const renderReplayButton = (row: HighscoreRow): string => {
  const mismatch = replayBuildMismatch(row);
  const cls = mismatch ? "lb-replay lb-replay-older" : "lb-replay";
  const title = mismatch ? `Recorded on a ${mismatch} build` : "Watch replay";
  const note = mismatch ? `<span class="lb-replay-note">${mismatch} build</span>` : "";
  return `<button class="${cls}" data-replay-id="${row.id}" title="${title}" type="button">▶</button>${note}`;
};

const renderLeaderboard = (game: Game) => {
  const rows = game.leaderboardRows;
  if (rows.length === 0) {
    game.leaderboardListEl.innerHTML =
      '<li class="leaderboard-status">No scores yet — be the first pilot on the board.</li>';
    return;
  }
  const expanded = game.leaderboardNeighborhood || game.leaderboardExpanded;
  const windowSize = expanded ? rows.length : visibleWindowSize(game);
  const start = expanded ? 0 : windowStart(game.leaderboardSelection, rows.length, windowSize);
  const end = expanded ? rows.length : Math.min(rows.length, start + windowSize);
  const sortKey = game.leaderboardSort;
  const sortCls = (k: Game["leaderboardSort"]) => (sortKey === k ? " lb-sort-active" : "");
  const header = `<li class="lb-header">
    <span class="lb-rank"></span>
    <span class="lb-name lb-sortable${sortCls("name")}" data-sort="name">Pilot</span>
    <span class="lb-score lb-sortable${sortCls("score")}" data-sort="score">Score</span>
    <span class="lb-combo lb-sortable${sortCls("rhythm")}" data-sort="rhythm">Rhythm</span>
    <span class="lb-wave lb-sortable${sortCls("wave")}" data-sort="wave">Wave</span>
    <span class="lb-date lb-sortable${sortCls("date")}" data-sort="date">When</span>
  </li>`;
  const items: string[] = [];
  for (let i = start; i < end; i++) {
    const row = rows[i];
    const safeName = escapeHtml(row.name);
    const combo = row.max_combo ?? 0;
    const comboTier = combo >= 12 ? "white" : combo >= 4 ? "gold" : combo >= 2 ? "cyan" : "dim";
    const wave = row.wave ?? 1;
    const cls = i === game.leaderboardSelection ? ' class="lb-self"' : "";
    const replayBtn =
      row.has_replay && replayBuildMismatch(row) !== "older" ? renderReplayButton(row) : "";
    const fromNow = formatFromNow(row.created_at);
    const exactDate = escapeHtml(formatExactDate(row.created_at));
    const dateCell = fromNow
      ? `<span class="lb-date"><span class="lb-date-text">${fromNow}</span><span class="lb-date-tip">${exactDate}</span></span>`
      : `<span class="lb-date"></span>`;
    // Clicking the name opens that pilot's full board. The attribute holds the
    //   escaped name; reading el.dataset.pilot hands back the decoded original.
    const nameBtn = `<button class="lb-name-link" data-pilot="${safeName}" type="button" title="See ${safeName}'s scores">${safeName}</button>`;
    items.push(`<li${cls}>
      <span class="lb-rank">${i + 1 + game.leaderboardRankBase}</span>
      <span class="lb-name">${nameBtn}${replayBtn}</span>
      <span class="lb-score">${row.score.toLocaleString()}</span>
      <span class="lb-combo lb-combo-${comboTier}">
        <span class="lb-combo-value">${combo}<span class="lb-combo-x">×</span></span>
      </span>
      <span class="lb-wave">${wave}</span>
      ${dateCell}
    </li>`);
  }
  game.leaderboardListEl.innerHTML = header + items.join("");
};

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (ch) =>
    ch === "&" ? "&amp;" : ch === "<" ? "&lt;" : ch === ">" ? "&gt;" : ch === '"' ? "&quot;" : "&#39;",
  );

// matches the API's MAX_LIMIT — fetching the full slice means a returning pilot
//   ranked anywhere in the top tier will be found by id and the rotation has
//   enough pilots to scroll through.
const LEADERBOARD_FETCH_LIMIT = 100;

// Mirrors the API's PLAYER_CATEGORY_LIMIT: the per-category union size and the
//   profile "load more" page size both use it, and it's where the score-desc
//   paging cursor resumes after the initial union.
const PLAYER_CATEGORY_LIMIT = 50;

// For the title-screen "Top entries only" view, keep each pilot's personal
//   best in *each* category (score, wave, rhythm) — so a pilot whose top-score
//   run is different from their top-wave run shows up multiple times, once
//   per category they lead. Runs that hold more than one PB collapse to a
//   single row via the row-id dedupe. Case-insensitive name match so
//   "RAEMON" and "raemon" share one pilot bucket.
const pickBest = (
  rows: HighscoreRow[],
  better: (a: HighscoreRow, b: HighscoreRow) => boolean,
): HighscoreRow | null => {
  let best: HighscoreRow | null = null;
  for (const row of rows) {
    if (!best || better(row, best)) best = row;
  }
  return best;
};

// Union two row lists by id, keeping `base` order and appending any rows from
//   `extra` not already present. Used to fold the recent-runs set into the
//   score-ranked pools without introducing duplicate ids.
const mergeById = (base: HighscoreRow[], extra: HighscoreRow[]): HighscoreRow[] => {
  const seen = new Set(base.map((r) => r.id));
  const out = [...base];
  for (const row of extra) {
    if (!seen.has(row.id)) {
      seen.add(row.id);
      out.push(row);
    }
  }
  return out;
};

const dedupeByName = (rows: HighscoreRow[]): HighscoreRow[] => {
  const byPilot = new Map<string, HighscoreRow[]>();
  for (const row of rows) {
    const key = row.name.toLowerCase();
    const list = byPilot.get(key);
    if (list) list.push(row);
    else byPilot.set(key, [row]);
  }
  const keptIds = new Set<number>();
  const out: HighscoreRow[] = [];
  for (const pilotRows of byPilot.values()) {
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

// ?player=NAME drives the pilot-profile view. Reading it on boot makes a shared
//   profile link land directly on that pilot's board; writing it on a name click
//   keeps the URL shareable and the browser back button meaningful.
const PLAYER_PARAM = "player";

const readPlayerParam = (): string | null => {
  try {
    const raw = new URLSearchParams(window.location.search).get(PLAYER_PARAM);
    const name = raw?.trim();
    return name ? name : null;
  } catch {
    return null;
  }
};

// Write ?player=NAME (or clear it) without reloading. A name click pushes a new
//   entry so Back returns to the prior view; a programmatic clear (run start)
//   replaces, so it scrubs the param without leaving dead history behind.
const setPlayerParam = (name: string | null, mode: "push" | "replace" = "push") => {
  try {
    const url = new URL(window.location.href);
    if (name) url.searchParams.set(PLAYER_PARAM, name);
    else url.searchParams.delete(PLAYER_PARAM);
    const state = { player: name ?? null };
    if (mode === "replace") window.history.replaceState(state, "", url);
    else window.history.pushState(state, "", url);
  } catch {
    // history may be unavailable (sandboxed iframe); the in-memory view still
    //   switches — only the shareable URL and Back button are lost.
  }
};

let popstateBound = false;
const bindPlayerPopstate = (game: Game) => {
  if (popstateBound) return;
  popstateBound = true;
  window.addEventListener("popstate", () => {
    // Only re-route the leaderboard while it owns the screen — mid-run the URL
    //   change shouldn't yank the player out of a game.
    if (game.leaderboardEl.classList.contains("hidden")) return;
    const name = readPlayerParam();
    game.leaderboardPlayerFilter = name;
    if (name) void renderPlayerProfile(game, name);
    else renderHallOfFame(game);
  });
};

// Starting a run leaves the pilot-profile view behind: clear the filter and the
//   ?player= URL so the post-run "your standing" view (and a later return to
//   title) shows the global board, not whatever profile was last open.
export const clearPlayerFilter = (game: Game) => {
  if (game.leaderboardPlayerFilter === null && readPlayerParam() === null) return;
  game.leaderboardPlayerFilter = null;
  setPlayerParam(null, "replace");
};

// The "Pulsar" title becomes a back-affordance only while a profile is open.
const syncTitleBackAffordance = (game: Game, isProfile: boolean) => {
  game.overlayTitleEl.classList.toggle("title-back", isProfile);
};

// User-initiated return from a pilot profile to the global board (clicking the
//   "Pulsar" title or the "Pilot" header). Pushes a history entry so Back goes
//   to the profile they came from. No-op when no profile is showing.
const exitPlayerProfile = (game: Game) => {
  if (!game.leaderboardPlayerFilter) return;
  game.leaderboardPlayerFilter = null;
  setPlayerParam(null);
  renderHallOfFame(game);
};

export const showLeaderboard = (game: Game) => {
  hideLeaderboardNotice();
  bindLeaderboardClicks(game);
  bindLeaderboardFooter(game);
  bindPlayerPopstate(game);
  game.leaderboardEl.classList.remove("hidden");
  // A ?player= URL (shared link or a name the player clicked) wins over every
  //   other view — show that pilot's full board.
  const player = game.leaderboardPlayerFilter ?? readPlayerParam();
  if (player) {
    game.leaderboardPlayerFilter = player;
    void renderPlayerProfile(game, player);
    return;
  }
  // One-shot post-run view: the first title screen after a submitted score shows
  //   the ±25 neighborhood centred on the player. Consume the flag immediately so
  //   a later return-to-title or reload reverts to the hall-of-fame.
  if (game.showNeighborhoodOnce && game.neighborhoodFetch) {
    const pending = game.neighborhoodFetch;
    game.showNeighborhoodOnce = false;
    game.neighborhoodFetch = null;
    void showNeighborhoodLeaderboard(game, pending);
    return;
  }
  renderHallOfFame(game);
};

// Pilot-profile view: every run by one pilot (top-50 per category, server-
//   gathered), rendered unfiltered and fully expanded. Column-header sorts still
//   work against this set; "show more" pages the pilot's remaining runs by score.
//   Falls back to the hall-of-fame if the pilot has no rows or the fetch fails.
const renderPlayerProfile = async (game: Game, name: string) => {
  hideLeaderboardNotice();
  game.leaderboardNeighborhood = false;
  game.leaderboardRankBase = 0;
  game.leaderboardTopOnly = false;
  game.leaderboardExpanded = true;
  game.leaderboardLoadingMore = false;
  game.leaderboardHasMore = false;
  game.leaderboardSort = "score";
  syncOverlayExpansion(true);
  syncShowMoreVisibility(game);
  // The footer stays visible for "show more", but the per-pilot dedupe toggle is
  //   meaningless on a single pilot's board — hide just that control.
  syncFooterVisibility(false);
  syncTopOnlyVisibility(true);
  syncTitleBackAffordance(game, true);
  game.leaderboardListEl.innerHTML =
    `<li class="leaderboard-status">Loading ${escapeHtml(name)}'s scores…</li>`;
  let rows: HighscoreRow[];
  let profileUser: PublicUser | null = null;
  try {
    const profile = await fetchPlayerScores(name);
    rows = profile.scores;
    profileUser = profile.user;
  } catch {
    // A failed fetch shouldn't strand the player on a blank list; clear the
    //   filter (and the URL) and drop back to the global board.
    game.leaderboardPlayerFilter = null;
    setPlayerParam(null, "replace");
    renderHallOfFame(game);
    return;
  }
  // The view may have moved on (player clicked Back / another name) while the
  //   fetch was in flight — don't clobber the newer view with stale rows.
  if (game.leaderboardPlayerFilter !== name) return;
  if (rows.length === 0) {
    game.leaderboardPlayerFilter = null;
    setPlayerParam(null, "replace");
    renderHallOfFame(game);
    return;
  }
  // Claimed-pilot stats banner above the board (hidden for guest pilots).
  renderProfileBanner(profileUser);
  game.leaderboardAllRows = rows;
  game.leaderboardTopPilots = rows;
  // The union's score slice covered the top PLAYER_CATEGORY_LIMIT runs, so that's
  //   where the score-desc "load more" cursor resumes. A full-size union means
  //   the pilot has at least that many runs and there may be more to page.
  game.leaderboardRankedCount = PLAYER_CATEGORY_LIMIT;
  game.leaderboardHasMore = rows.length >= PLAYER_CATEGORY_LIMIT;
  applySort(game, null);
  syncShowMoreVisibility(game);
};

// "Load more" on a profile: page the pilot's next runs by score-desc, dedupe
//   against what's shown, and append. Mirrors loadMoreLeaderboard but hits the
//   per-pilot endpoint and keys off leaderboardPlayerFilter.
const loadMorePlayerScores = async (game: Game) => {
  const name = game.leaderboardPlayerFilter;
  if (!name || game.leaderboardLoadingMore || !game.leaderboardHasMore) return;
  game.leaderboardLoadingMore = true;
  syncShowMoreVisibility(game);
  try {
    const offset = game.leaderboardRankedCount;
    const page = await fetchPlayerPage(name, offset, PLAYER_CATEGORY_LIMIT);
    // A view switch mid-fetch (Back, another pilot) means these rows are stale.
    if (game.leaderboardPlayerFilter !== name) return;
    const existingIds = new Set(game.leaderboardAllRows.map((r) => r.id));
    const fresh = page.filter((r) => !existingIds.has(r.id));
    game.leaderboardRankedCount += page.length;
    game.leaderboardAllRows = [...game.leaderboardAllRows, ...fresh];
    game.leaderboardTopPilots = game.leaderboardAllRows;
    game.leaderboardHasMore = page.length >= PLAYER_CATEGORY_LIMIT;
    applySort(game, null);
  } catch {
    // leave the existing list intact; the player can retry by clicking again.
  } finally {
    if (game.leaderboardPlayerFilter === name) {
      game.leaderboardLoadingMore = false;
      syncShowMoreVisibility(game);
    }
  }
};

// The default title-screen view: deduped "top pilots" hall-of-fame, fully
//   expanded, refreshed from the network behind cached rows.
const renderHallOfFame = (game: Game) => {
  game.leaderboardNeighborhood = false;
  game.leaderboardRankBase = 0;
  game.leaderboardTopOnly = getTopEntriesOnly();
  game.leaderboardExpanded = true;
  game.leaderboardLoadingMore = false;
  syncOverlayExpansion(true);
  syncShowMoreVisibility(game);
  syncFooterUi(game);
  syncFooterVisibility(false);
  syncTopOnlyVisibility(false);
  syncTitleBackAffordance(game, false);
  renderProfileBanner(null);
  game.leaderboardSort = "score";
  // Paint cached rows immediately so the title screen is never blank on reload;
  //   the in-flight fetch will swap them out with fresh data when it lands.
  const cached = getCachedHighscores();
  if (cached.length > 0) {
    // The cache holds the deep top-pilots payload; seed both sources from it so
    //   the toggle works before the live top-100 lands.
    game.leaderboardTopPilots = cached;
    game.leaderboardAllRows = cached;
    applySort(game, null);
  } else {
    game.leaderboardListEl.innerHTML =
      `<li class="leaderboard-status">Loading top pilots…</li>`;
    game.leaderboardTopPilots = [];
    game.leaderboardAllRows = [];
    game.leaderboardRows = [];
    game.leaderboardSelection = 0;
    game.leaderboardActive = false;
  }
  void refreshLeaderboard(game);
};

// Post-run "your standing": render the pre-fetched ±25 neighborhood with the
//   player's row centred on the page. Falls back to the hall-of-fame if the
//   fetch failed or returned nothing.
const showNeighborhoodLeaderboard = async (
  game: Game,
  pending: Promise<{ scores: HighscoreRow[]; selfRank: number } | null>,
) => {
  game.leaderboardNeighborhood = true;
  game.leaderboardExpanded = true;
  game.leaderboardTopOnly = false;
  game.leaderboardLoadingMore = false;
  syncOverlayExpansion(true);
  syncFooterVisibility(true);
  syncShowMoreVisibility(game);
  syncTitleBackAffordance(game, false);
  renderProfileBanner(null);
  game.leaderboardListEl.innerHTML =
    `<li class="leaderboard-status">Loading your standing…</li>`;
  const result = await pending;
  if (!result || result.scores.length === 0) {
    renderHallOfFame(game);
    return;
  }
  const rows = result.scores;
  const selfIdx = rows.findIndex((r) => r.id === game.lastRunScoreId);
  game.leaderboardAllRows = rows;
  game.leaderboardRows = rows;
  game.leaderboardSelection = selfIdx >= 0 ? selfIdx : 0;
  // selfRank is the anchor's global rank; back out the rank of the first row so
  //   every rendered row shows its true position.
  game.leaderboardRankBase = result.selfRank - 1 - (selfIdx >= 0 ? selfIdx : 0);
  game.leaderboardActive = true;
  renderLeaderboard(game);
  scrollSelfToCenter(game);
};

// Scroll the overlay so the highlighted self row sits at viewport centre. One
//   rAF lets the reveal transition + layout settle before measuring.
const scrollSelfToCenter = (game: Game) => {
  requestAnimationFrame(() => {
    const overlay = document.getElementById("overlay");
    const self = game.leaderboardListEl.querySelector<HTMLElement>(".lb-self");
    if (!overlay || !self) return;
    // Rect-relative so it's correct regardless of offsetParent nesting: how far
    //   the self row's centre is from the overlay's current scroll viewport top,
    //   then shift so that point lands at the viewport's vertical centre.
    const overlayRect = overlay.getBoundingClientRect();
    const selfRect = self.getBoundingClientRect();
    const selfCenterInView = selfRect.top - overlayRect.top + selfRect.height / 2;
    const target = overlay.scrollTop + selfCenterInView - overlay.clientHeight / 2;
    overlay.scrollTop = Math.max(0, target);
  });
};

export const refreshLeaderboard = async (game: Game) => {
  // The hall-of-fame never highlights/centres a self row — the post-run
  //   neighborhood view owns that. Passing null keeps it fully expanded even
  //   when lastRunScoreId is still set from the run just played.
  const selfId = null;
  // Two-phase. Phase 1: the deep top-pilots set (server-deduped, scanned far
  //   enough for ~20 distinct scores) — this is what the default "top entries
  //   only" view renders. Phase 2: the raw top-100, which powers the view once
  //   the toggle is turned OFF and is the base for "show more" paging. Phase 2
  //   must NOT clobber the phase-1 view — the raw top-100 can be one pilot deep.
  // The recent-runs set folds into both pools below. Fetched once up front and
  //   reused; a failure here just means recent-only runs stay absent until the
  //   next refresh — the score-ranked views still render.
  const recentRows = await fetchRecentScores().catch(() => [] as HighscoreRow[]);
  let paintedInitial = false;
  try {
    const initial = await fetchTopPilots();
    paintedInitial = true;
    // Fold recent runs into the dedupe pool so a fresh personal-best surfaces in
    //   the default view; dedupeByName then keeps only category bests per pilot.
    const pool = mergeById(initial, recentRows);
    saveCachedHighscores(pool);
    game.leaderboardTopPilots = pool;
    game.leaderboardHasMore = true;
    applySort(game, selfId);
    syncShowMoreVisibility(game);
  } catch {
    // fall through to the full fetch — it can still recover the view.
  }
  try {
    const rows = await fetchHighscores(LEADERBOARD_FETCH_LIMIT);
    const hadFullPage = rows.length >= LEADERBOARD_FETCH_LIMIT;
    game.leaderboardRankedCount = rows.length;
    // Append recent-only runs so the "When" sort (toggle off) can reach fresh
    //   runs that fell outside the top-by-score window.
    game.leaderboardAllRows = mergeById(rows, recentRows);
    game.leaderboardHasMore = hadFullPage;
    // Re-render only matters when the toggle is off (the on-view reads the
    //   phase-1 set); applySort handles both and is cheap.
    applySort(game, selfId);
    syncShowMoreVisibility(game);
  } catch {
    if (!paintedInitial && game.leaderboardTopPilots.length === 0) {
      game.leaderboardListEl.innerHTML =
        '<li class="leaderboard-status">Leaderboard unavailable.</li>';
      game.leaderboardActive = false;
    }
  }
};

// Fetches the next page of rows past what's already loaded, dedupes by id
//   against the in-memory rows (in case new submissions shifted offsets), and
//   appends. Updates hasMore based on whether the page was full.
const loadMoreLeaderboard = async (game: Game) => {
  if (game.leaderboardLoadingMore || !game.leaderboardHasMore) return;
  game.leaderboardLoadingMore = true;
  syncShowMoreVisibility(game);
  try {
    // Page by the score-ranked count, not the merged length — the recent-only
    //   runs folded in for the "When" sort aren't part of the score-ordered cursor.
    const offset = game.leaderboardRankedCount;
    const rows = await fetchHighscores(LEADERBOARD_FETCH_LIMIT, offset);
    const existingIds = new Set(game.leaderboardAllRows.map((r) => r.id));
    const fresh = rows.filter((r) => !existingIds.has(r.id));
    game.leaderboardRankedCount += rows.length;
    game.leaderboardAllRows = [...game.leaderboardAllRows, ...fresh];
    game.leaderboardHasMore = rows.length >= LEADERBOARD_FETCH_LIMIT;
    applySort(game, null);
  } catch {
    // leave the existing list intact; user can retry by clicking again.
  } finally {
    game.leaderboardLoadingMore = false;
    syncShowMoreVisibility(game);
  }
};

// Renders from the deep top-pilots set when "top entries only" is on, else
//   from the full top-100. The deep set still gets a client dedupe pass so a
//   stale or over-broad payload can't leak duplicate pilot rows.
const applySort = (game: Game, selfId: number | null) => {
  // The post-run standing view is server-ordered by rank; column-header sorts
  //   and footer toggles don't apply, and re-sorting would break the rank base.
  if (game.leaderboardNeighborhood) return;
  const filtered = game.leaderboardTopOnly
    ? dedupeByName(game.leaderboardTopPilots)
    : game.leaderboardAllRows;
  const sorted = sortRows(filtered, game.leaderboardSort);
  game.leaderboardRows = sorted;
  if (selfId !== null) {
    const selfIdx = sorted.findIndex((r) => r.id === selfId);
    game.leaderboardSelection = selfIdx >= 0 ? selfIdx : 0;
  } else {
    game.leaderboardSelection = 0;
  }
  game.leaderboardActive = sorted.length > 0;
  renderLeaderboard(game);
};

const syncFooterUi = (game: Game) => {
  const checkbox = document.getElementById("leaderboard-top-only-input") as HTMLInputElement | null;
  if (checkbox) checkbox.checked = game.leaderboardTopOnly;
};

// Hide the whole footer (filter toggle + show-more) on the post-run "your
//   standing" view; the player wants to see their actual rank there, not a
//   deduped global view.
const syncFooterVisibility = (hide: boolean) => {
  const footer = document.getElementById("leaderboard-footer");
  if (footer) footer.classList.toggle("hidden", hide);
};

// Hide just the "top entries only" control (keeping "show more"); used on a
//   pilot profile, where per-pilot dedupe is meaningless but paging still is.
const syncTopOnlyVisibility = (hide: boolean) => {
  const toggle = document.getElementById("leaderboard-top-only");
  if (toggle) toggle.classList.toggle("hidden", hide);
};

let leaderboardFooterBound = false;
const bindLeaderboardFooter = (game: Game) => {
  if (leaderboardFooterBound) return;
  const checkbox = document.getElementById("leaderboard-top-only-input") as HTMLInputElement | null;
  const showMore = document.getElementById("leaderboard-show-more");
  if (!checkbox || !showMore) return;
  leaderboardFooterBound = true;
  checkbox.addEventListener("change", () => {
    game.leaderboardTopOnly = checkbox.checked;
    saveTopEntriesOnly(checkbox.checked);
    applySort(game, null);
  });
  showMore.addEventListener("click", () => {
    if (game.leaderboardLoadingMore) return;
    // On a pilot profile the list is already fully expanded; "show more" just
    //   pages that pilot's next runs from the per-pilot endpoint.
    if (game.leaderboardPlayerFilter) {
      void loadMorePlayerScores(game);
      return;
    }
    if (game.leaderboardTopOnly) {
      game.leaderboardTopOnly = false;
      saveTopEntriesOnly(false);
      syncFooterUi(game);
    }
    // First click expands the rendered window to show every loaded row.
    //   Subsequent clicks page the next 50 from the server and append.
    const justExpanded = !game.leaderboardExpanded;
    if (justExpanded) {
      game.leaderboardExpanded = true;
      syncOverlayExpansion(true);
      applySort(game, null);
      syncShowMoreVisibility(game);
      return;
    }
    void loadMoreLeaderboard(game);
  });
};

const syncOverlayExpansion = (expanded: boolean) => {
  const overlay = document.getElementById("overlay");
  if (overlay) overlay.classList.toggle("leaderboard-expanded", expanded);
};

const syncShowMoreVisibility = (game: Game) => {
  const btn = document.getElementById("leaderboard-show-more");
  if (!btn) return;
  // Hide once we've expanded AND there's nothing more the server could give us.
  //   Otherwise the button persists in the bottom-left so the player can keep
  //   loading more pages.
  const nothingToShow = game.leaderboardExpanded && !game.leaderboardHasMore;
  btn.classList.toggle("hidden", nothingToShow);
  btn.textContent = game.leaderboardLoadingMore ? "loading…" : "show more";
  (btn as HTMLButtonElement).disabled = game.leaderboardLoadingMore;
};

let leaderboardClicksBound = false;
const bindLeaderboardClicks = (game: Game) => {
  if (leaderboardClicksBound) return;
  leaderboardClicksBound = true;
  // Clicking the "Pulsar" title exits a pilot profile back to the global board.
  //   When no profile is open it stays inert (cursor set per-view below) so the
  //   title-screen click can't be mistaken for a Start.
  game.overlayTitleEl.addEventListener("click", (ev) => {
    if (!game.leaderboardPlayerFilter) return;
    if (game.leaderboardEl.classList.contains("hidden")) return;
    ev.stopPropagation();
    exitPlayerProfile(game);
  });
  game.leaderboardListEl.addEventListener("click", (ev) => {
    const el = ev.target as HTMLElement | null;
    if (!el) return;
    const replayEl = el.closest<HTMLElement>("[data-replay-id]");
    if (replayEl) {
      ev.stopPropagation();
      const id = Number(replayEl.dataset.replayId);
      if (id > 0) void launchReplay(game, id);
      return;
    }
    const nameEl = el.closest<HTMLElement>("[data-pilot]");
    if (nameEl) {
      // Stop the click bubbling to the overlay, which would start a run.
      ev.stopPropagation();
      const pilot = nameEl.dataset.pilot?.trim();
      if (!pilot || pilot === game.leaderboardPlayerFilter) return;
      game.leaderboardPlayerFilter = pilot;
      setPlayerParam(pilot);
      void renderPlayerProfile(game, pilot);
      return;
    }
    const sortEl = el.closest<HTMLElement>("[data-sort]");
    if (!sortEl) return;
    const key = sortEl.dataset.sort as Game["leaderboardSort"] | undefined;
    if (!key) return;
    // On a pilot profile the "Pilot" header doubles as the way back to the
    //   global board (sorting one pilot's runs by name is meaningless).
    if (game.leaderboardPlayerFilter && key === "name") {
      ev.stopPropagation();
      exitPlayerProfile(game);
      return;
    }
    if (key === game.leaderboardSort) return;
    game.leaderboardSort = key;
    // Sorting by recency only makes sense across every run, so drop the
    //   one-row-per-pilot filter when the player asks for "When".
    if (key === "date" && game.leaderboardTopOnly) {
      game.leaderboardTopOnly = false;
      saveTopEntriesOnly(false);
      syncFooterUi(game);
    }
    applySort(game, null);
  });
};

const LEADERBOARD_NOTICE_MS = 6000;
let leaderboardNoticeTimer = 0;

const showLeaderboardNotice = (msg: string) => {
  const el = document.getElementById("leaderboard-notice");
  if (!el) return;
  el.textContent = msg;
  el.classList.remove("hidden");
  window.clearTimeout(leaderboardNoticeTimer);
  leaderboardNoticeTimer = window.setTimeout(() => el.classList.add("hidden"), LEADERBOARD_NOTICE_MS);
};

const hideLeaderboardNotice = () => {
  window.clearTimeout(leaderboardNoticeTimer);
  document.getElementById("leaderboard-notice")?.classList.add("hidden");
};

const OLDER_BUILD_NOTICE = "Replay from an older build — can't be played.";
const NEWER_BUILD_NOTICE = "Replay from a newer build — refresh to watch.";

const launchReplay = async (game: Game, scoreId: number) => {
  const row = game.leaderboardRows.find((r) => r.id === scoreId);
  const mismatch = row ? replayBuildMismatch(row) : null;
  if (mismatch) {
    showLeaderboardNotice(mismatch === "newer" ? NEWER_BUILD_NOTICE : OLDER_BUILD_NOTICE);
    return;
  }
  try {
    const bytes = await fetchReplay(scoreId);
    await startReplay(game, bytes);
  } catch (err) {
    console.error("[replay launch] failed:", err);
    showLeaderboardNotice(
      err instanceof UnsupportedReplayVersionError
        ? OLDER_BUILD_NOTICE
        : "Replay unavailable — couldn't load that run.",
    );
  }
};

// up/down on title + gameover slide the yellow selector toward the centre of
// the visible window; once centred, further presses scroll the underlying
// list by clamping selection ± 1 against the row count.
export const moveLeaderboardSelection = (game: Game, delta: number) => {
  if (!game.leaderboardActive) return;
  const total = game.leaderboardRows.length;
  if (total === 0) return;
  const next = game.leaderboardSelection + delta;
  if (next < 0 || next >= total) return;
  game.leaderboardSelection = next;
  renderLeaderboard(game);
};

// Holding ↑/↓ should keep scrolling: an initial press fires immediately,
//   then after a short delay we tick at a steady cadence. Tracked per
//   direction so reversing mid-hold restarts the delay.
const REPEAT_DELAY = 0.35;
const REPEAT_INTERVAL = 0.08;
let upHeldTime = -1;
let upNextFireAt = 0;
let downHeldTime = -1;
let downNextFireAt = 0;

const tickRepeatDirection = (
  game: Game,
  dt: number,
  isDown: boolean,
  heldRef: { held: number; nextAt: number },
  delta: number,
): { held: number; nextAt: number } => {
  if (!isDown) return { held: -1, nextAt: 0 };
  let { held, nextAt } = heldRef;
  if (held < 0) {
    moveLeaderboardSelection(game, delta);
    return { held: 0, nextAt: REPEAT_DELAY };
  }
  held += dt;
  while (held >= nextAt) {
    moveLeaderboardSelection(game, delta);
    nextAt += REPEAT_INTERVAL;
  }
  return { held, nextAt };
};

export const tickLeaderboardKeyRepeat = (game: Game, dt: number) => {
  const upState = tickRepeatDirection(
    game,
    dt,
    game.input.down("arrowup"),
    { held: upHeldTime, nextAt: upNextFireAt },
    -1,
  );
  upHeldTime = upState.held;
  upNextFireAt = upState.nextAt;
  const downState = tickRepeatDirection(
    game,
    dt,
    game.input.down("arrowdown"),
    { held: downHeldTime, nextAt: downNextFireAt },
    1,
  );
  downHeldTime = downState.held;
  downNextFireAt = downState.nextAt;
};
