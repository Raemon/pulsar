export type AcquisitionIdentity = {
  playerId: string;
  firstSeenAt: string;
  source: string;
  medium: string;
  campaign: string | null;
  content: string | null;
  existingPlayer: boolean;
};

const IDENTITY_KEY = "pulsar.acquisition.v1";
// sessionTracker wrote this before acquisition tracking existed.
const LAST_RUN_KEY = "pulsar.lastRunStartAt.v1";
const FIELD_LIMIT = 100;
const INVALID_TAG = /[\u0000-\u001f\u007f/?#=&]/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
let pageIdentity: Promise<AcquisitionIdentity> | undefined;

export const createAcquisitionId = (): string => {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  // LAN playtests on HTTP have getRandomValues but no randomUUID.
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join("-");
};

const hasPriorRun = (): boolean => {
  try {
    return window.localStorage.getItem(LAST_RUN_KEY) !== null;
  } catch {
    return false;
  }
};

// A referrer can contain a private path, a search query or credentials. Only
// the hostname of an external web origin can be used as a source.
const referringHost = (): string | null => {
  try {
    const url = new URL(document.referrer);
    if ((url.protocol === "http:" || url.protocol === "https:") && url.origin !== window.location.origin) {
      return url.hostname.slice(0, FIELD_LIMIT);
    }
  } catch {
    // Empty referrer on direct or privacy-preserving visits.
  }
  return null;
};

const landingIdentity = (): AcquisitionIdentity => {
  const query = new URLSearchParams(window.location.search);
  const tag = (name: string): string | null => {
    const value = query.get(name)?.trim();
    // Read labels only; never persist a pasted URL or nested query string.
    if (!value || INVALID_TAG.test(value)) return null;
    return value.slice(0, FIELD_LIMIT).replace(/[\uD800-\uDBFF]$/u, "").trimEnd();
  };
  const source = tag("utm_source");
  const medium = tag("utm_medium");
  const campaign = tag("utm_campaign");
  const content = tag("utm_content");
  const tagged = Boolean(source || medium || campaign || content);
  const host = referringHost();
  return {
    playerId: createAcquisitionId(),
    firstSeenAt: new Date().toISOString(),
    source: source ?? host ?? (tagged ? "unknown" : "direct"),
    medium: medium ?? (host ? "referral" : tagged ? "unknown" : "none"),
    campaign,
    content,
    existingPlayer: hasPriorRun(),
  };
};

const readIdentity = (raw: string | null): AcquisitionIdentity | null => {
  if (!raw) return null;
  try {
    const item = JSON.parse(raw);
    const isLabel = (value: unknown) => typeof value === "string" && value.trim() === value
      && value.length > 0 && value.length <= FIELD_LIMIT && !INVALID_TAG.test(value);
    if (item && typeof item.playerId === "string" && UUID.test(item.playerId)
      && typeof item.firstSeenAt === "string" && new Date(item.firstSeenAt).toISOString() === item.firstSeenAt
      && isLabel(item.source) && isLabel(item.medium)
      && (item.campaign === null || isLabel(item.campaign)) && (item.content === null || isLabel(item.content))
      && typeof item.existingPlayer === "boolean") return item as AcquisitionIdentity;
  } catch {
    // Corrupt or outdated storage can be replaced on the current visit.
  }
  return null;
};

const persistFirstTouch = (landing: AcquisitionIdentity): AcquisitionIdentity => {
  for (const kind of ["localStorage", "sessionStorage"] as const) {
    try {
      const storage = window[kind];
      const previous = readIdentity(storage.getItem(IDENTITY_KEY));
      if (previous) return previous;
      storage.setItem(IDENTITY_KEY, JSON.stringify(landing));
      return landing;
    } catch {
      // Quota limits and privacy settings can prevent reads or writes.
    }
  }
  return landing;
};

/** Capture before gameplay can update the old run marker or navigate. */
export const getAcquisitionIdentity = (): Promise<AcquisitionIdentity> => {
  if (!pageIdentity) {
    const landing = landingIdentity();
    const persist = () => persistFirstTouch(landing);
    // Two new tabs can land together. Serialize the read/create operation
    // so their events carry the same player ID and first-touch labels.
    pageIdentity = (async () => {
      try {
        const locks = window.navigator.locks;
        if (locks) return await locks.request(IDENTITY_KEY, persist);
      } catch {
        // Lock access can also be denied in a sandboxed frame.
      }
      return persist();
    })();
  }
  return pageIdentity;
};
