/**
 * classify.test.ts
 * -------------------------------------------------------------------------
 * Unit tests for angle classification, hook extraction, and the EU reach
 * scoping helper used by the "rising winner" confirmation logic.
 * -------------------------------------------------------------------------
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyAngles, extractHook, looksLikeAmpouleProduct } from "../src/classify.js";
import { computeScopedReachPerDay } from "../src/scraper.js";
import type { EuTransparency } from "../src/scraper.js";

test("classifyAngles: detects the Botox-comparison angle", () => {
  const text = "Botox costs €300 per session and freezes the muscle — this ampoule doesn't.";
  const angles = classifyAngles(text);
  assert.ok(angles.some((a) => a.includes("Botox")));
});

test("classifyAngles: detects the mechanism/penetration angle", () => {
  const text = "Le collagène pénètre jusqu'au derme, contrairement à une crème qui reste en surface.";
  const angles = classifyAngles(text);
  assert.ok(angles.some((a) => a.includes("Mechanisme")));
});

test("classifyAngles: an ad can match more than one angle", () => {
  const text = "Mon secret coréen: le botox en ampoule qui pénètre la peau. Un cadeau pour toi.";
  const angles = classifyAngles(text);
  assert.ok(angles.length >= 2);
});

test("classifyAngles: returns an empty array for unrelated copy", () => {
  assert.deepEqual(classifyAngles("Buy our running shoes, 20% off today."), []);
});

test("extractHook: takes the first sentence of the first line", () => {
  const text = "Laten we de berekening maken. Botox kost €300 per sessie.\nRest of the ad.";
  assert.equal(extractHook(text), "Laten we de berekening maken.");
});

test("extractHook: falls back to the whole first line when there's no sentence break", () => {
  const text = "Du botox en bouteille?\nMore copy here.";
  assert.equal(extractHook(text), "Du botox en bouteille?");
});

test("extractHook: returns null for empty text", () => {
  assert.equal(extractHook(""), null);
});

test("looksLikeAmpouleProduct: true for ampoule-family copy", () => {
  assert.equal(looksLikeAmpouleProduct("This Korean silk ampoule reaches the dermis."), true);
});

test("looksLikeAmpouleProduct: false for unrelated copy", () => {
  assert.equal(looksLikeAmpouleProduct("Buy our running shoes, 20% off today."), false);
});

function makeEu(overrides: Partial<EuTransparency> = {}): EuTransparency {
  return {
    reach: 1000,
    countries: ["France", "Germany"],
    audience: [],
    topSegment: null,
    ...overrides,
  };
}

test("computeScopedReachPerDay: sums only rows in the target countries", () => {
  const eu = makeEu({
    reach: 1000,
    audience: [
      { location: "France", ageRange: "35-44", gender: "Female", reach: 300 },
      { location: "Germany", ageRange: "35-44", gender: "Female", reach: 200 },
      { location: "Romania", ageRange: "35-44", gender: "Female", reach: 500 },
    ],
  });
  const scoped = computeScopedReachPerDay(eu, ["France", "Germany"], 1);
  assert.equal(scoped, 500);
});

test("computeScopedReachPerDay: divides by days running", () => {
  const eu = makeEu({
    audience: [{ location: "France", ageRange: "35-44", gender: "Female", reach: 1000 }],
  });
  const scoped = computeScopedReachPerDay(eu, ["France"], 4);
  assert.equal(scoped, 250);
});

test("computeScopedReachPerDay: falls back to overall reach when there's no per-row breakdown but the country matches", () => {
  const eu = makeEu({ reach: 900, countries: ["France"], audience: [] });
  const scoped = computeScopedReachPerDay(eu, ["France", "Germany"], 1);
  assert.equal(scoped, 900);
});

test("computeScopedReachPerDay: returns 0 when the ad's countries don't overlap the target list", () => {
  const eu = makeEu({ reach: 900, countries: ["Romania"], audience: [] });
  const scoped = computeScopedReachPerDay(eu, ["France", "Germany"], 1);
  assert.equal(scoped, 0);
});
