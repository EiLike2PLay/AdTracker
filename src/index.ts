#!/usr/bin/env node
/**
 * index.ts
 * -------------------------------------------------------------------------
 * AdRadar CLI entry point.
 *
 * Wires together the four pillars:
 *   scraper  -> pull the competitor's live ads from the Meta Ad Library
 *   storage  -> diff against the last snapshot, detect new + winner ads
 *   notifier -> push rich alerts to Slack / Discord
 *   (this)   -> argument parsing + a pretty, colorful progress narrative
 *
 * Exit codes:
 *   0  success (with or without findings)
 *   1  a hard failure (bad args, scrape crash, unwritable snapshot)
 * -------------------------------------------------------------------------
 */

import { Command } from "commander";
import { config as loadEnv } from "dotenv";
import { resolve } from "node:path";
import {
  bold,
  cyan,
  dim,
  green,
  magenta,
  red,
  yellow,
} from "colorette";
import {
  checkEuTransparency,
  computeScopedReachPerDay,
  computeTopCountries,
  resolveDiscoveryUrl,
  resolveTargetUrl,
  scrapeAdLibrary,
} from "./scraper.js";
import { loadSnapshot, reconcile, saveSnapshot, computeDaysRunning } from "./storage.js";
import { buildNotificationItems, notify } from "./notifier.js";
import { classifyAngles, extractHook } from "./classify.js";
import type { RuntimeConfig, StoredAd } from "./types.js";

loadEnv();

const VERSION = "1.0.0";

interface CliOptions {
  pageId?: string;
  url?: string;
  keyword?: string;
  excludePages: string;
  country: string;
  data: string;
  winnerDays: string;
  minReachPerDay: string;
  newAdMaxAge: string;
  targetCountries: string;
  risingConfirmDays: string;
  maxScrolls: string;
  headless: boolean;
  slackWebhook?: string;
  discordWebhook?: string;
  discordWebhookNewProducts?: string;
  dryRun: boolean;
  timeout: string;
  quiet: boolean;
}

function buildProgram(): Command {
  const program = new Command();

  program
    .name("adradar")
    .description(
      "Radar for your competitors' Meta (Facebook) ads — scrape the Ad Library, " +
        "detect new creatives & long-running winners, and alert Slack/Discord.",
    )
    .version(VERSION, "-v, --version", "print the AdRadar version")
    .option("-p, --page-id <id>", "Facebook page id to monitor")
    .option("-u, --url <url>", "full Ad Library URL (overrides --page-id)")
    .option(
      "-k, --keyword <text>",
      "search the Ad Library by free-text keyword instead of a known page id " +
        "(overrides --page-id/--url) — for discovering unknown/new competitors",
    )
    .option(
      "--exclude-pages <list>",
      "comma-separated advertiser names to drop from the results (e.g. pages already tracked via their own job)",
      "",
    )
    .option("-c, --country <code>", "Ad Library country filter (e.g. US, ALL)", "ALL")
    .option("-d, --data <file>", "path to the snapshot JSON", "data/snapshot.json")
    .option("-w, --winner-days <n>", "days running to qualify as a winner", "7")
    .option(
      "--min-reach-per-day <n>",
      "EU reach/day above which a new ad is flagged as a 'rising' winner",
      "1500",
    )
    .option(
      "--new-ad-max-age <n>",
      "max age (days) for a new ad to be checked for EU reach / rising status",
      "7",
    )
    .option(
      "--target-countries <list>",
      "comma-separated EU countries that count toward the 'rising' reach/day (as named in the Ad Library, e.g. France,Germany)",
      "France,Germany,Netherlands,Belgium,Italy,Spain",
    )
    .option(
      "--rising-confirm-days <n>",
      "consecutive daily checks above --min-reach-per-day required before 'rising' is confirmed",
      "3",
    )
    .option("-s, --max-scrolls <n>", "max infinite-scroll passes", "40")
    .option("--no-headless", "run with a visible browser window")
    .option("--slack-webhook <url>", "Slack incoming webhook (or SLACK_WEBHOOK_URL)")
    .option("--discord-webhook <url>", "Discord webhook for the product-specific channel (or DISCORD_WEBHOOK_URL)")
    .option(
      "--discord-webhook-new-products <url>",
      "Discord webhook for the 'new products' catch-all channel (or DISCORD_WEBHOOK_URL_NEW_PRODUCTS)",
    )
    .option("--dry-run", "scrape & diff but send no notifications", false)
    .option("--timeout <ms>", "per-navigation timeout in ms", "60000")
    .option("-q, --quiet", "suppress progress chatter", false);

  return program;
}

/**
 * Merge CLI flags + environment into a fully-resolved {@link RuntimeConfig},
 * validating required inputs along the way.
 */
function resolveConfig(opts: CliOptions): RuntimeConfig {
  const keyword = opts.keyword?.trim() || null;

  let pageId: string;
  let targetUrl: string;

  if (keyword) {
    // Discovery mode: search by keyword instead of tracking one known page.
    pageId = `discover:${keyword}`;
    targetUrl = resolveDiscoveryUrl(keyword, opts.country);
  } else {
    const rawPage = opts.url ?? opts.pageId ?? process.env["ADRADAR_PAGE_ID"];

    if (!rawPage || rawPage.trim().length === 0) {
      throw new UsageError(
        "Missing target. Provide --page-id <id>, --url <adLibraryUrl>, or --keyword <text> " +
          "(or set ADRADAR_PAGE_ID).",
      );
    }

    pageId = opts.url ? opts.url.trim() : rawPage.trim();
    targetUrl = resolveTargetUrl(rawPage, opts.country);
  }

  const excludePageNames = opts.excludePages
    .split(",")
    .map((n) => n.trim())
    .filter((n) => n.length > 0);

  const winnerThresholdDays = toPositiveInt(opts.winnerDays, "winner-days");
  const minReachPerDay = toPositiveInt(opts.minReachPerDay, "min-reach-per-day");
  const newAdMaxAgeDays = toPositiveInt(opts.newAdMaxAge, "new-ad-max-age");
  const risingConfirmDays = toPositiveInt(opts.risingConfirmDays, "rising-confirm-days");
  const targetCountries = opts.targetCountries
    .split(",")
    .map((c) => c.trim())
    .filter((c) => c.length > 0);
  const maxScrolls = toPositiveInt(opts.maxScrolls, "max-scrolls");
  const navigationTimeoutMs = toPositiveInt(opts.timeout, "timeout");

  return {
    pageId,
    targetUrl,
    country: opts.country,
    dataFile: resolve(process.cwd(), opts.data),
    winnerThresholdDays,
    minReachPerDay,
    newAdMaxAgeDays,
    targetCountries,
    risingConfirmDays,
    discoveryKeyword: keyword,
    excludePageNames,
    maxScrolls,
    headless: opts.headless,
    slackWebhookUrl:
      opts.slackWebhook ?? process.env["SLACK_WEBHOOK_URL"] ?? null,
    discordWebhookUrl:
      opts.discordWebhook ?? process.env["DISCORD_WEBHOOK_URL"] ?? null,
    discordWebhookUrlNewProducts:
      opts.discordWebhookNewProducts ??
      process.env["DISCORD_WEBHOOK_URL_NEW_PRODUCTS"] ??
      null,
    dryRun: opts.dryRun,
    navigationTimeoutMs,
  };
}

class UsageError extends Error {}

function toPositiveInt(value: string, name: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    throw new UsageError(`--${name} must be a positive integer (got "${value}")`);
  }
  return n;
}

/* ---------------------------------------------------------------------- *
 *  Main orchestration                                                     *
 * ---------------------------------------------------------------------- */

async function run(config: RuntimeConfig, quiet: boolean): Promise<number> {
  const log = quiet ? () => {} : (msg: string) => process.stderr.write(msg + "\n");
  const progress = (msg: string) => log(`  ${dim("›")} ${msg}`);

  banner(log);

  log(bold(cyan("\n▸ Target")));
  log(
    config.discoveryKeyword
      ? `  mode     : ${magenta("keyword discovery")} — "${config.discoveryKeyword}"`
      : `  page/url : ${magenta(config.pageId)}`,
  );
  log(`  country  : ${config.country}`);
  log(`  url      : ${dim(config.targetUrl)}`);
  log(`  snapshot : ${dim(config.dataFile)}`);
  log(
    `  winner≥  : ${config.winnerThresholdDays}d   rising≥: ${config.minReachPerDay}/d × ${config.risingConfirmDays}d (≤${config.newAdMaxAgeDays}d old, ${config.targetCountries.join("/")})   maxScrolls: ${config.maxScrolls}   headless: ${config.headless}`,
  );

  /* --- 1) Scrape ----------------------------------------------------- */
  log(bold(cyan("\n▸ Scraping Meta Ad Library")));
  const startedAt = Date.now();
  let ads = await scrapeAdLibrary(config, progress);
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);

  // In keyword-discovery mode, drop ads from advertisers we already track via
  // their own dedicated page job — they'd otherwise get reported twice.
  if (config.excludePageNames.length > 0) {
    const excludeSet = new Set(config.excludePageNames.map((n) => n.toLowerCase()));
    const before = ads.length;
    ads = ads.filter((ad) => !ad.pageName || !excludeSet.has(ad.pageName.toLowerCase()));
    if (before !== ads.length) {
      log(dim(`  ⓘ filtered out ${before - ads.length} ad(s) from already-tracked page(s)`));
    }
  }

  if (ads.length === 0) {
    log(yellow(`  ⚠ No active ads found (took ${elapsed}s).`));
    log(
      dim(
        "    The page may have no live ads, be region-restricted, or Meta " +
          "changed its DOM. Try --no-headless to watch the run.",
      ),
    );
  } else {
    log(green(`  ✓ Scraped ${bold(String(ads.length))} active ad(s) in ${elapsed}s`));
  }

  /* --- 2) Diff against the last snapshot ----------------------------- */
  log(bold(cyan("\n▸ Reconciling against snapshot")));
  const previous = await loadSnapshot(config.dataFile, config.pageId);
  const priorCount = Object.keys(previous.ads).length;
  log(dim(`  loaded ${priorCount} previously-tracked ad(s)`));

  const nowIso = new Date().toISOString();
  const diff = reconcile(ads, previous, config.winnerThresholdDays, nowIso);

  log(
    `  ${green(`🆕 ${diff.newAds.length} new`)}  ·  ` +
      `${yellow(`🏆 ${diff.longRunningWinners.length} winner(s)`)}  ·  ` +
      `${dim(`${diff.stillRunning.length} still running`)}`,
  );

  printFindings(log, diff.newAds, "NEW", nowIso);
  printFindings(log, diff.longRunningWinners, "WINNER", nowIso);

  /* --- 3) Angle + hook tagging on everything we might announce --------- *
   * Cheap, text-only classification — applied regardless of EU-check
   * eligibility so even old "winner" ads get tagged. */
  for (const ad of [...diff.newAds, ...diff.longRunningWinners]) {
    ad.angles = classifyAngles(ad.text);
    ad.hook = extractHook(ad.text);
  }

  /* --- 4) EU reach check + multi-day "rising" confirmation ------------- *
   * Two groups of candidates:
   *   - brand-new, still-active ads (≤ newAdMaxAgeDays old)
   *   - ads already mid-confirmation from a previous run (< risingConfirmDays
   *     history entries so far, not yet confirmed)
   * Bounded on purpose — checking the whole tracked history every run would
   * mean one navigation per ad, which does not scale. A "rising" winner only
   * fires once its last `risingConfirmDays` daily checks all clear
   * `minReachPerDay` in the configured target countries — a single lucky
   * spike is not enough. */
  const freshCandidates = diff.newAds.filter(
    (ad) => ad.active && computeDaysRunning(ad, nowIso) <= config.newAdMaxAgeDays,
  );
  const pendingCandidates = Object.values(diff.snapshot.ads).filter(
    (ad) =>
      ad.active &&
      !ad.notifiedAsRising &&
      (ad.reachHistory?.length ?? 0) > 0 &&
      (ad.reachHistory?.length ?? 0) < config.risingConfirmDays &&
      !freshCandidates.some((c) => c.adId === ad.adId),
  );
  // Winners get a one-off reach lookup too (no multi-day confirmation —
  // they're already validated by the time-based rule) purely so the winner
  // notification can show "Reach totaal" / "Reach gemiddeld" alongside the
  // rest. Skip it once we already know the number.
  const winnerCandidates = diff.longRunningWinners.filter(
    (ad) => typeof ad.euReach !== "number",
  );
  const reachCandidates = [...freshCandidates, ...pendingCandidates, ...winnerCandidates];

  const confirmedRising: StoredAd[] = [];

  if (reachCandidates.length > 0) {
    log(
      bold(cyan(`\n▸ Checking EU reach for ${reachCandidates.length} ad(s)`)),
    );
    const euResults = await checkEuTransparency(
      config,
      reachCandidates.map((ad) => ad.adId),
      progress,
    );
    const risingEligibleIds = new Set(
      [...freshCandidates, ...pendingCandidates].map((ad) => ad.adId),
    );
    for (const ad of reachCandidates) {
      const eu = euResults.get(ad.adId);
      if (!eu) continue; // not shown in the EU (or lookup failed) — skip, don't break the streak with a false zero

      ad.euReach = eu.reach;
      ad.euCountries = eu.countries;
      ad.euTopSegment = eu.topSegment;
      ad.euTopCountries = computeTopCountries(eu, 3);

      if (!risingEligibleIds.has(ad.adId)) continue; // winner-only lookup — no confirmation bookkeeping needed

      const daysRunning = computeDaysRunning(ad, nowIso);
      const scopedReachPerDay = computeScopedReachPerDay(eu, config.targetCountries, daysRunning);
      const today = nowIso.slice(0, 10);

      // Keep at most one entry per calendar date — running this workflow
      // more than once a day must not let "N consecutive days" collapse
      // into "N runs within a day or two". A same-day rerun just refreshes
      // today's reading instead of appending a duplicate.
      const history = ad.reachHistory ?? [];
      const todayIndex = history.findIndex((h) => h.date === today);
      if (todayIndex >= 0) {
        history[todayIndex] = { date: today, reachPerDay: scopedReachPerDay };
      } else {
        history.push({ date: today, reachPerDay: scopedReachPerDay });
      }
      ad.reachHistory = history.slice(-config.risingConfirmDays);

      const confirmed =
        !ad.notifiedAsRising &&
        ad.reachHistory.length >= config.risingConfirmDays &&
        ad.reachHistory.every((h) => h.reachPerDay >= config.minReachPerDay);

      if (confirmed) {
        ad.notifiedAsRising = true;
        confirmedRising.push(ad);
      }
    }
  }

  /* --- 5) Persist the merged snapshot -------------------------------- */
  await saveSnapshot(config.dataFile, diff.snapshot);
  log(dim(`\n  💾 Snapshot written (${Object.keys(diff.snapshot.ads).length} ad(s) tracked)`));

  /* --- 6) Notify — only vuistregel-gevalideerde items ------------------ *
   * Plain "new" sightings are never pushed: they show up in the run log
   * (printFindings above) for visibility, but only a confirmed "winner"
   * (≥ winnerThresholdDays) or a confirmed "rising" ad (risingConfirmDays
   * consecutive days ≥ minReachPerDay) is validated enough to notify on. */
  const items = buildNotificationItems(diff.longRunningWinners, confirmedRising, nowIso);

  if (confirmedRising.length > 0) {
    log(
      yellow(
        `  🚀 ${confirmedRising.length} rising winner(s) confirmed (${config.risingConfirmDays}d ≥ ${config.minReachPerDay}/d in ${config.targetCountries.join(", ")})`,
      ),
    );
  }

  if (items.length === 0) {
    log(dim("\n▸ Nothing new to announce. Radar is quiet. 😴"));
    return 0;
  }

  log(bold(cyan("\n▸ Dispatching notifications")));
  const outcome = await notify(items, config);

  if (outcome.slackSent > 0) log(green(`  ✓ Slack: ${outcome.slackSent} ad(s)`));
  if (outcome.discordSent > 0) log(green(`  ✓ Discord: ${outcome.discordSent} ad(s)`));
  for (const err of outcome.errors) {
    // dry-run / no-webhook are informational, real failures are warnings.
    if (err.startsWith("dry-run") || err.startsWith("no webhook")) {
      log(dim(`  ⓘ ${err}`));
    } else {
      log(red(`  ✗ ${err}`));
    }
  }

  log(green(bold("\n✓ AdRadar sweep complete.\n")));
  return 0;
}

function printFindings(
  log: (msg: string) => void,
  ads: StoredAd[],
  label: "NEW" | "WINNER",
  nowIso: string,
): void {
  if (ads.length === 0) return;
  const tag = label === "WINNER" ? yellow("🏆 WINNER") : green("🆕 NEW");
  for (const ad of ads) {
    const days = computeDaysRunning(ad, nowIso);
    const name = ad.pageName ? bold(ad.pageName) : dim("(unknown advertiser)");
    const preview = (ad.text || "(no copy)").replace(/\s+/g, " ").slice(0, 90);
    log(`    ${tag} ${name} ${dim(`[${ad.adId}]`)} ${dim(`${days}d`)}`);
    log(`        ${dim("“" + preview + (preview.length >= 90 ? "…" : "") + "”")}`);
    if (ad.media[0]) log(`        ${dim("media: " + ad.media[0].url.slice(0, 96))}`);
  }
}

function banner(log: (msg: string) => void): void {
  log(
    magenta(
      bold("\n  ╔═══════════════════════════════════════╗"),
    ),
  );
  log(magenta(bold("  ║          📡  A D R A D A R            ║")));
  log(
    magenta(
      bold("  ╚═══════════════════════════════════════╝"),
    ),
  );
  log(dim("  Competitive Meta-ad radar · new & winner detection"));
}

/* ---------------------------------------------------------------------- *
 *  Bootstrap                                                              *
 * ---------------------------------------------------------------------- */

async function main(): Promise<void> {
  const program = buildProgram();
  program.parse(process.argv);
  const opts = program.opts<CliOptions>();

  try {
    const config = resolveConfig(opts);
    const code = await run(config, opts.quiet);
    process.exit(code);
  } catch (err) {
    if (err instanceof UsageError) {
      process.stderr.write(red(`\n✗ ${err.message}\n\n`));
      program.outputHelp();
      process.exit(1);
    }
    const message = err instanceof Error ? err.stack ?? err.message : String(err);
    process.stderr.write(red(`\n✗ AdRadar failed:\n${message}\n`));
    process.exit(1);
  }
}

void main();
