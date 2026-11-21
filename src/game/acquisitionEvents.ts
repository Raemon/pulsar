import { createAcquisitionId, getAcquisitionIdentity, type AcquisitionIdentity } from "./acquisitionAttribution";

type EventType = "visit" | "run_started" | "rhythm_12" | "run_completed";
type AcquisitionEvent = AcquisitionIdentity & { type: EventType; occurredAt: string; runId?: string };
export type AcquisitionRun = { id: string; reached12: boolean };

const PREFIX = "pulsar.acquisition.pending.v1.";
const pending = new Map<string, string>();
let identity: Promise<AcquisitionIdentity> | undefined;
let sending = false;
let retryTimer: number | undefined;
let retryDelay = 2_000;

// Each immutable milestone has its own storage key. Writes from two tabs
// cannot overwrite each other's runs, and duplicate deliveries are idempotent.
const enqueue = (event: AcquisitionEvent) => {
  const key = PREFIX + (event.runId ?? event.playerId) + "." + event.type;
  const body = JSON.stringify(event);
  pending.set(key, body);
  try {
    localStorage.setItem(key, body);
  } catch {
    // The in-memory queue still serves the current page when storage is full or blocked.
  }
  void flush();
};

const flush = async () => {
  if (sending || retryTimer !== undefined) return;
  sending = true;
  try {
    for (const [key, body] of pending) {
      const response = await fetch("/api/acquisition", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        keepalive: true,
      });
      // A validation failure is permanent for this immutable body. Other
      // failures (including a fallback HTML page) stay queued for retry.
      if (response.status !== 204 && response.status !== 400 && response.status !== 422) break;
      pending.delete(key);
      try {
        localStorage.removeItem(key);
      } catch {
        // A later reload can submit the same key safely.
      }
      retryDelay = 2_000;
    }
  } catch {
    // Offline, interrupted navigation, or a temporarily unavailable API.
  } finally {
    sending = false;
    if (pending.size > 0) {
      retryTimer = window.setTimeout(retryNow, retryDelay);
      retryDelay = Math.min(300_000, retryDelay * 2);
    }
  }
};

const retryNow = () => {
  window.clearTimeout(retryTimer);
  retryTimer = undefined;
  void flush();
};

// Only the actual game page initializes delivery. Importing the game graph
// in a replay/resimulation tool never captures an identity or sends events.
export const initAcquisition = () => {
  if (identity || new URLSearchParams(window.location.search).get("debug") === "true") return;
  identity = getAcquisitionIdentity();
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key?.startsWith(PREFIX)) continue;
      const body = localStorage.getItem(key);
      if (body) pending.set(key, body);
    }
  } catch {
    // Storage is optional.
  }
  window.addEventListener("online", retryNow);
  void flush();
  void identity.then(player => enqueue({ ...player, type: "visit", occurredAt: player.firstSeenAt })).catch(() => {});
};

const record = (type: Exclude<EventType, "visit">, runId: string) => {
  const occurredAt = new Date().toISOString();
  void identity?.then(player => enqueue({ ...player, type, runId, occurredAt })).catch(() => {});
};

export const startAcquisitionRun = (): AcquisitionRun | null => {
  if (!identity) return null;
  const id = createAcquisitionId();
  record("run_started", id);
  return { id, reached12: false };
};

export const recordAcquisitionRhythm = (run: AcquisitionRun, peak: number) => {
  if (run.reached12 || peak < 12) return;
  run.reached12 = true;
  record("rhythm_12", run.id);
};

export const completeAcquisitionRun = (run: AcquisitionRun) => record("run_completed", run.id);
