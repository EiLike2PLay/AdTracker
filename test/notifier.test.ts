/**
 * notifier.test.ts
 * -------------------------------------------------------------------------
 * Unit tests for the two-channel Discord routing: Ampoule-family ads go to
 * `discordWebhookUrl`, everything else goes to `discordWebhookUrlNewProducts`.
 * `axios.post` is mocked so no real HTTP request ever leaves the test run.
 * -------------------------------------------------------------------------
 */

import { test, mock, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import axios from "axios";
import { notify, buildNotificationItems } from "../src/notifier.js";
import type { NotificationItem, RuntimeConfig, StoredAd } from "../src/types.js";

const AMPOULE_WEBHOOK = "https://discord.com/api/webhooks/AAA/ampoule";
const NEW_PRODUCTS_WEBHOOK = "https://discord.com/api/webhooks/BBB/new-products";

function makeConfig(overrides: Partial<RuntimeConfig> = {}): RuntimeConfig {
  return {
    pageId: "page-123",
    targetUrl: "https://www.facebook.com/ads/library/?id=page-123",
    country: "FR",
    dataFile: "data/page-123.json",
    winnerThresholdDays: 7,
    minReachPerDay: 2000,
    newAdMaxAgeDays: 7,
    targetCountries: ["France", "Germany"],
    risingConfirmDays: 3,
    discoveryKeyword: null,
    excludePageNames: [],
    discordWebhookUrlNewProducts: null,
    maxScrolls: 40,
    headless: true,
    slackWebhookUrl: null,
    discordWebhookUrl: null,
    dryRun: false,
    navigationTimeoutMs: 60000,
    ...overrides,
  };
}

function makeAd(overrides: Partial<StoredAd> = {}): StoredAd {
  return {
    adId: "ad-1",
    startedRunningRaw: "Started running on Jun 1, 2026",
    startedRunningOn: "2026-06-01",
    text: "Buy our thing",
    media: [{ type: "image", url: "https://cdn.example/creative.jpg" }],
    pageName: "Acme",
    adLibraryUrl: "https://www.facebook.com/ads/library/?id=ad-1",
    active: true,
    firstSeenAt: "2026-06-01T00:00:00.000Z",
    lastSeenAt: "2026-06-01T00:00:00.000Z",
    seenCount: 1,
    notifiedAsWinner: false,
    ...overrides,
  };
}

function makeItem(reason: NotificationItem["reason"], ad: Partial<StoredAd>): NotificationItem {
  return { reason, ad: makeAd(ad), daysRunning: 3 };
}

let posted: Array<{ url: string; body: unknown }>;

beforeEach(() => {
  posted = [];
  mock.method(axios, "post", async (url: string, body: unknown) => {
    posted.push({ url, body });
    return { status: 204, data: {} };
  });
});

afterEach(() => {
  mock.restoreAll();
});

test("notify: routes Ampoule-family copy to discordWebhookUrl", async () => {
  const config = makeConfig({
    discordWebhookUrl: AMPOULE_WEBHOOK,
    discordWebhookUrlNewProducts: NEW_PRODUCTS_WEBHOOK,
  });
  const items = [
    makeItem("new", { adId: "ampoule-1", text: "This Korean silk ampoule reaches the dermis." }),
  ];

  const outcome = await notify(items, config);

  assert.equal(outcome.discordSent, 1);
  assert.equal(posted.length, 1);
  assert.equal(posted[0]!.url, AMPOULE_WEBHOOK);
});

test("notify: routes unrelated product copy to discordWebhookUrlNewProducts", async () => {
  const config = makeConfig({
    discordWebhookUrl: AMPOULE_WEBHOOK,
    discordWebhookUrlNewProducts: NEW_PRODUCTS_WEBHOOK,
  });
  const items = [
    makeItem("new", { adId: "other-1", text: "Buy our running shoes, 20% off today." }),
  ];

  const outcome = await notify(items, config);

  assert.equal(outcome.discordSent, 1);
  assert.equal(posted.length, 1);
  assert.equal(posted[0]!.url, NEW_PRODUCTS_WEBHOOK);
});

test("notify: a mixed batch is split across both webhooks in one call", async () => {
  const config = makeConfig({
    discordWebhookUrl: AMPOULE_WEBHOOK,
    discordWebhookUrlNewProducts: NEW_PRODUCTS_WEBHOOK,
  });
  const items = [
    makeItem("new", { adId: "ampoule-1", text: "Botox costs €300 — this ampoule doesn't." }),
    makeItem("new", { adId: "other-1", text: "Buy our running shoes, 20% off today." }),
    makeItem("winner", { adId: "ampoule-2", text: "Le collagène pénètre jusqu'au derme." }),
  ];

  const outcome = await notify(items, config);

  assert.equal(outcome.discordSent, 3);
  assert.equal(posted.length, 2);

  const ampoulePost = posted.find((p) => p.url === AMPOULE_WEBHOOK);
  const otherPost = posted.find((p) => p.url === NEW_PRODUCTS_WEBHOOK);
  assert.ok(ampoulePost, "expected a post to the Ampoule webhook");
  assert.ok(otherPost, "expected a post to the new-products webhook");

  const ampouleEmbeds = (ampoulePost!.body as { embeds: unknown[] }).embeds;
  const otherEmbeds = (otherPost!.body as { embeds: unknown[] }).embeds;
  assert.equal(ampouleEmbeds.length, 2);
  assert.equal(otherEmbeds.length, 1);
});

test("notify: falls back to discordWebhookUrl for 'other' items when no second webhook is configured", async () => {
  const config = makeConfig({
    discordWebhookUrl: AMPOULE_WEBHOOK,
    discordWebhookUrlNewProducts: null,
  });
  const items = [
    makeItem("new", { adId: "ampoule-1", text: "This Korean silk ampoule reaches the dermis." }),
    makeItem("new", { adId: "other-1", text: "Buy our running shoes, 20% off today." }),
  ];

  const outcome = await notify(items, config);

  assert.equal(outcome.discordSent, 2);
  // Both groups land on the single configured webhook, as two separate posts.
  assert.ok(posted.every((p) => p.url === AMPOULE_WEBHOOK));
});

test("notify: dry-run sends nothing to either webhook", async () => {
  const config = makeConfig({
    discordWebhookUrl: AMPOULE_WEBHOOK,
    discordWebhookUrlNewProducts: NEW_PRODUCTS_WEBHOOK,
    dryRun: true,
  });
  const items = [makeItem("new", { adId: "ampoule-1", text: "This ampoule reaches the dermis." })];

  const outcome = await notify(items, config);

  assert.equal(posted.length, 0);
  assert.equal(outcome.discordSent, 0);
  assert.ok(outcome.errors.some((e) => e.startsWith("dry-run")));
});

test("buildNotificationItems: only winners and confirmed-rising ads are included, never plain 'new' sightings", () => {
  const winner = makeAd({ adId: "winner-1" });
  const rising = makeAd({ adId: "rising-1" });

  const items = buildNotificationItems([winner], [rising], "2026-06-28T12:00:00.000Z");

  assert.equal(items.length, 2);
  assert.ok(items.some((i) => i.reason === "winner" && i.ad.adId === "winner-1"));
  assert.ok(items.some((i) => i.reason === "rising" && i.ad.adId === "rising-1"));
  assert.ok(!items.some((i) => i.reason === "new"));
});

test("buildNotificationItems: returns nothing when there are no validated ads", () => {
  assert.deepEqual(buildNotificationItems([], []), []);
});

test("notify: falls back to a Library-ID-based link when adLibraryUrl was never captured", async () => {
  const config = makeConfig({ discordWebhookUrl: AMPOULE_WEBHOOK });
  const items = [
    makeItem("winner", {
      adId: "12345678901234",
      text: "Ampoule copy",
      adLibraryUrl: null,
    }),
  ];

  await notify(items, config);

  const body = posted[0]!.body as {
    embeds: Array<{ url?: string; fields: Array<{ name: string; value: string }> }>;
  };
  const embed = body.embeds[0]!;
  const linkField = embed.fields.find((f) => f.name === "🔗 Ad");
  assert.ok(linkField, "expected a link field even without a captured adLibraryUrl");
  assert.ok(linkField!.value.includes("ads/library/?id=12345678901234"));
  assert.ok(embed.url?.includes("ads/library/?id=12345678901234"));
});

test("notify: an ad's own embed carries its detected angle and hook", async () => {
  const config = makeConfig({ discordWebhookUrl: AMPOULE_WEBHOOK });
  const items = [
    makeItem("rising", {
      adId: "ampoule-1",
      text: "Laten we de berekening maken.\nBotox kost €300 per sessie.",
      angles: ["Angle A — Botox-vergelijking"],
      hook: "Laten we de berekening maken.",
    }),
  ];

  await notify(items, config);

  const body = posted[0]!.body as {
    embeds: Array<{ description: string; fields: Array<{ name: string; value: string }> }>;
  };
  const fields = body.embeds[0]!.fields;
  assert.ok(fields.some((f) => f.name === "Angle" && f.value.includes("Botox-vergelijking")));
  // The hook is the embed's short description, not a separate field.
  assert.equal(body.embeds[0]!.description, "Laten we de berekening maken.");
});

test("notify: reach fields prefer the scoped daily average over the lifetime average, and include a link to the ad", async () => {
  const config = makeConfig({ discordWebhookUrl: AMPOULE_WEBHOOK });
  const items = [
    makeItem("rising", {
      adId: "ampoule-1",
      text: "Ampoule copy",
      euReach: 9000,
      euCountries: ["France"],
      reachHistory: [
        { date: "2026-06-26", reachPerDay: 2500 },
        { date: "2026-06-27", reachPerDay: 3000 },
        { date: "2026-06-28", reachPerDay: 3500 },
      ],
      adLibraryUrl: "https://www.facebook.com/ads/library/?id=ampoule-1",
    }),
  ];

  await notify(items, config);

  const body = posted[0]!.body as { embeds: Array<{ fields: Array<{ name: string; value: string }> }> };
  const fields = body.embeds[0]!.fields;
  assert.ok(fields.some((f) => f.name === "Reach totaal (EU)" && f.value === "9,000"));
  // Average of the 3 daily readings (2500, 3000, 3500) = 3000, not 9000 / daysRunning.
  // The value also spells out the reach : looptijd ratio, not just the bare number.
  assert.ok(
    fields.some(
      (f) => f.name === "Reach gemiddeld/dag" && f.value.startsWith("3,000/dag") && f.value.includes("3d"),
    ),
  );
  assert.ok(
    fields.some((f) => f.name === "🔗 Ad" && f.value.includes("ads/library/?id=ampoule-1")),
  );
});

test("notify: embed shows the top-3 best-performing countries by reach, best first", async () => {
  const config = makeConfig({ discordWebhookUrl: AMPOULE_WEBHOOK });
  const items = [
    makeItem("rising", {
      adId: "ampoule-1",
      text: "Ampoule copy",
      euReach: 9000,
      euTopCountries: [
        { country: "France", reach: 5200 },
        { country: "Germany", reach: 3100 },
        { country: "Belgium", reach: 700 },
      ],
    }),
  ];

  await notify(items, config);

  const body = posted[0]!.body as { embeds: Array<{ fields: Array<{ name: string; value: string }> }> };
  const field = body.embeds[0]!.fields.find((f) => f.name === "Land(en) — best presterend");
  assert.ok(field, "expected a top-countries field");
  assert.equal(field!.value, "France (5,200) · Germany (3,100) · Belgium (700)");
});
