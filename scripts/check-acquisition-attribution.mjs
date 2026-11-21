import assert from "node:assert/strict";
import test from "node:test";

const memoryStorage = () => {
  const entries = new Map();
  return {
    getItem: key => entries.get(key) ?? null,
    setItem: (key, value) => entries.set(key, value),
  };
};

let pages = 0;
// Fresh module per page load, same browser storage across visits.
const openPage = async ({ localStorage = memoryStorage(), sessionStorage = memoryStorage(), search = "", referrer = "" } = {}) => {
  globalThis.window = { localStorage, sessionStorage, location: new URL("https://pulsar.test/" + search), navigator: {} };
  globalThis.document = { referrer };
  const { getAcquisitionIdentity } = await import(`../src/game/acquisitionAttribution.ts?page=${++pages}`);
  return getAcquisitionIdentity();
};

test("a new campaign visitor retains identity and first touch after playing, reloading and following another campaign", async () => {
  const localStorage = memoryStorage();
  const first = await openPage({
    localStorage,
    search: "?utm_source=forum&utm_medium=community&utm_campaign=NecroDancer&utm_content=clip-A",
    referrer: "https://another.test/private?token=secret",
  });
  assert.deepEqual([first.source, first.medium, first.campaign, first.content, first.existingPlayer],
    ["forum", "community", "NecroDancer", "clip-A", false]);
  assert.match(first.playerId, /^[0-9a-f-]{36}$/i);
  assert.equal(new Date(first.firstSeenAt).toISOString(), first.firstSeenAt);
  localStorage.setItem("pulsar.lastRunStartAt.v1", String(Date.now()));
  assert.deepEqual(await openPage({ localStorage }), first);
  assert.deepEqual(await openPage({ localStorage, search: "?utm_campaign=second" }), first);
});

test("direct first touch persists on later campaign visits; a browser with a prior run is marked existing", async () => {
  const localStorage = memoryStorage();
  localStorage.setItem("pulsar.lastRunStartAt.v1", String(Date.now()));
  const first = await openPage({ localStorage, referrer: "https://pulsar.test/?player=someone" });
  assert.deepEqual([first.source, first.medium, first.campaign, first.content, first.existingPlayer],
    ["direct", "none", null, null, true]);
  assert.deepEqual(await openPage({ localStorage, search: "?utm_source=reddit" }), first);
});

test("untagged referrals contain only the hostname; malformed and partial UTMs are bounded", async () => {
  const referral = await openPage({ referrer: "https://community.test/r/private?access_token=secret" });
  assert.deepEqual([referral.source, referral.medium], ["community.test", "referral"]);
  const partial = await openPage({ search: "?utm_campaign=" + "x".repeat(120) + "&utm_content=https%3A%2F%2Fprivate.test" });
  assert.deepEqual([partial.source, partial.medium, partial.campaign, partial.content], ["unknown", "unknown", "x".repeat(100), null]);
});

test("blocked persistent storage still allows play across a same-tab reload", async () => {
  const localStorage = { getItem() { throw new Error("Storage disabled"); } };
  const sessionStorage = memoryStorage();
  const first = await openPage({ localStorage, sessionStorage, search: "?utm_source=forum" });
  assert.deepEqual(await openPage({ localStorage, sessionStorage }), first);
});
