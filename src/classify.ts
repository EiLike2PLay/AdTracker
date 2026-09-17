/**
 * classify.ts
 * -------------------------------------------------------------------------
 * Lightweight, keyword-based "angle" classification and hook extraction for
 * scraped ad copy. No ML — the vocabulary per angle is distinctive enough
 * (Botox pricing vs. dermis/penetration vs. insider-secret language) that a
 * scored keyword match is both cheap and legible to tune by hand.
 *
 * The angle list is intentionally a plain, editable array: add a new
 * `{ id, label, keywords }` entry to extend coverage to a new angle without
 * touching the matching logic itself.
 * -------------------------------------------------------------------------
 */

export interface AngleDefinition {
  id: string;
  label: string;
  keywords: string[];
}

/**
 * Keyword sets per angle. Matching is case-insensitive substring search
 * against the full ad copy. Add more entries here as new angles emerge
 * (competitor or our own) — this list is not limited to three.
 */
export const ANGLE_DEFINITIONS: AngleDefinition[] = [
  {
    id: "botox-comparison",
    label: "Botox-vergelijking",
    keywords: [
      "botox",
      "€300",
      "300 euros",
      "300 €",
      "injection",
      "injectie",
      "aiguille",
      "naald",
      "fige",
      "bevriest",
      "filler",
    ],
  },
  {
    id: "mechanism-penetration",
    label: "Mechanisme/penetratie",
    keywords: [
      "dermis",
      "pénètre",
      "dringt door",
      "fibroblast",
      "collagène",
      "collageen",
      "hoornlaag",
      "couche cornée",
      "molecule",
      "molécule",
      "dalton",
      "reste en surface",
      "blijft liggen",
    ],
  },
  {
    id: "insider-secret",
    label: "Insider/celebrity-secret",
    keywords: [
      "secret",
      "geheim",
      "actrice",
      "actress",
      "maquillage",
      "make-up artist",
      "insider",
      "célébrité",
      "celebrity",
      "coréenne",
      "koreaans",
    ],
  },
  {
    id: "testimonial-story",
    label: "Testimonial/persoonlijk verhaal",
    keywords: [
      "mon mari",
      "mijn man",
      "mon ex",
      "divorce",
      "scheiding",
      "j'ai vu",
      "ik zag",
      "il y a",
      "jaar geleden",
      "ans plus tard",
    ],
  },
  {
    id: "gift-bundle",
    label: "Cadeau/bundel-framing",
    keywords: [
      "cadeau",
      "gift",
      "un pour toi",
      "één voor jou",
      "2+1",
      "3+2",
      "bundle",
      "bundel",
      "gratis",
      "gratuit",
    ],
  },
];

/**
 * Score every angle by how many distinct keywords it matches in `text`, and
 * return the labels of every angle with at least one match, best match
 * first. An ad can legitimately hit more than one angle (e.g. a testimonial
 * that also leans on the Botox-comparison claim) — we surface all matches
 * rather than forcing a single pick.
 */
export function classifyAngles(text: string): string[] {
  if (!text) return [];
  const haystack = text.toLowerCase();

  const scored = ANGLE_DEFINITIONS.map((angle) => {
    const hits = angle.keywords.filter((kw) => haystack.includes(kw.toLowerCase()));
    return { label: angle.label, score: hits.length };
  }).filter((s) => s.score > 0);

  scored.sort((a, b) => b.score - a.score);
  return scored.map((s) => s.label);
}

/**
 * Best-effort "hook" extraction: the first non-empty line/sentence of the ad
 * copy, which is where scripted hook-ads put their opening line (see the
 * Ampoule launch strategy's own hook tables). Works identically for video
 * and static ads because both expose their primary text through the same
 * scraped `text` field — this does NOT transcribe spoken audio.
 */
export function extractHook(text: string, maxLength = 140): string | null {
  if (!text) return null;

  const firstLine = text
    .split(/\n+/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);

  if (!firstLine) return null;

  // Prefer the first sentence within that line when it's meaningfully
  // shorter than the whole line (avoids grabbing a run-on paragraph).
  const sentenceMatch = firstLine.match(/^.{10,}?[.!?…]/);
  const candidate = sentenceMatch ? sentenceMatch[0] : firstLine;

  return candidate.length > maxLength
    ? candidate.slice(0, maxLength - 1) + "…"
    : candidate;
}

/**
 * Whether an ad's copy looks like it belongs to the Ampoule product family
 * (any angle keyword match, or an explicit product-name mention) — used to
 * route notifications to the "Ampoule" vs. "new products" Discord channel.
 */
export function looksLikeAmpouleProduct(text: string): boolean {
  if (!text) return false;
  const haystack = text.toLowerCase();
  if (haystack.includes("ampoule") || haystack.includes("ampul")) return true;
  return classifyAngles(text).length > 0;
}
