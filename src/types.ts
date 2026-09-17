/**
 * types.ts
 * -------------------------------------------------------------------------
 * Central, strict type definitions for AdRadar.
 *
 * Everything that crosses a module boundary (scraper -> storage -> notifier)
 * is described here so that the compiler — with `strict: true` — can catch
 * shape mismatches before they ever reach the Meta Ad Library DOM.
 * -------------------------------------------------------------------------
 */

/**
 * The kind of media attached to an ad creative.
 */
export type CreativeMediaType = "image" | "video" | "unknown";

/**
 * A single media asset extracted from an ad card.
 */
export interface CreativeMedia {
  /** "image" | "video" | "unknown" */
  type: CreativeMediaType;
  /** Direct URL to the asset (CDN image, mp4, or poster frame). */
  url: string;
  /**
   * For videos, the poster/thumbnail frame if Meta exposes one separately.
   * Used by the notifier to render a preview even for video creatives.
   */
  thumbnailUrl?: string;
}

/**
 * A normalized advertisement, as produced by the scraper.
 *
 * This is the canonical "wire" shape. The storage layer enriches it with
 * tracking metadata (see {@link StoredAd}).
 */
export interface Ad {
  /**
   * Stable identifier for the ad. Meta exposes a "Library ID" per ad; when it
   * is missing we synthesize a deterministic hash from the ad's content so the
   * diffing logic still has something stable to key on.
   */
  adId: string;

  /** Raw "Started running on ..." string exactly as scraped (for display). */
  startedRunningRaw: string | null;

  /**
   * Parsed ISO-8601 date (YYYY-MM-DD) of when the ad started running, if we
   * were able to parse {@link startedRunningRaw}; otherwise null.
   */
  startedRunningOn: string | null;

  /** The main body copy / primary text of the ad. */
  text: string;

  /** Zero or more media assets attached to the creative. */
  media: CreativeMedia[];

  /**
   * The "Sponsored" / page display name shown on the card, when available.
   * Useful for multi-page libraries and for nicer notifications.
   */
  pageName: string | null;

  /** The permalink to this specific ad in the Ad Library, when resolvable. */
  adLibraryUrl: string | null;

  /** Whether Meta still marks the ad as "Active" at scrape time. */
  active: boolean;
}

/**
 * An {@link Ad} after it has been persisted at least once. The storage layer
 * stamps it with first/last-seen timestamps so trend detection is possible.
 */
export interface StoredAd extends Ad {
  /** ISO timestamp when AdRadar first observed this ad. */
  firstSeenAt: string;
  /** ISO timestamp of the most recent run that observed this ad. */
  lastSeenAt: string;
  /** How many distinct runs have observed this ad. */
  seenCount: number;
  /**
   * True once we have fired the "long-running winner" notification, so we do
   * not spam the same evergreen ad on every single run.
   */
  notifiedAsWinner: boolean;
  /**
   * EU DSA transparency reach (estimated accounts reached in the EU), fetched
   * for new ads only — see {@link RuntimeConfig.minReachPerDay}. `null` when
   * the ad has never been checked or was never shown in the EU.
   */
  euReach?: number | null;
  /** Countries this ad's EU audience was targeted at, when reach is known. */
  euCountries?: string[] | null;
  /** Human-readable description of the single largest demographic segment. */
  euTopSegment?: string | null;
  /** The (up to) 3 countries where this ad's EU reach is currently highest, sorted descending. */
  euTopCountries?: Array<{ country: string; reach: number }> | null;
  /**
   * Daily reach snapshots scoped to {@link RuntimeConfig.targetCountries},
   * one entry per day this ad was checked. Used to confirm a "rising"
   * classification only once several consecutive days clear the threshold,
   * instead of firing on a single lucky reading.
   */
  reachHistory?: Array<{ date: string; reachPerDay: number }>;
  /**
   * True once we've fired the "rising winner" notification for this ad, so a
   * confirmed rising ad is not re-announced on every subsequent run.
   */
  notifiedAsRising?: boolean;
  /** Detected marketing angle(s), e.g. "Botox-vergelijking". Empty when nothing matched. */
  angles?: string[];
  /** Best-effort opening line/hook extracted from the ad copy. */
  hook?: string | null;
}

/**
 * The on-disk snapshot schema. Versioned so future migrations are painless.
 */
export interface Snapshot {
  /** Schema version of this snapshot file. */
  version: 1;
  /** The page id / library identifier this snapshot tracks. */
  pageId: string;
  /** ISO timestamp of the last successful run. */
  updatedAt: string;
  /** Map of adId -> StoredAd. */
  ads: Record<string, StoredAd>;
}

/**
 * The result of reconciling a fresh scrape against the previous snapshot.
 */
export interface DiffResult {
  /** Ads observed for the very first time on this run. */
  newAds: StoredAd[];
  /**
   * Ads that have been active for >= the winner threshold and have not yet
   * been announced as winners.
   */
  longRunningWinners: StoredAd[];
  /** Ads seen previously and again now (not new, not newly-winning). */
  stillRunning: StoredAd[];
  /** The full, merged snapshot to be written back to disk. */
  snapshot: Snapshot;
}

/**
 * Why a given ad is being announced. Drives the headline/emoji in notifiers.
 *
 * "rising" is a "new" ad whose EU reach-per-day already clears
 * {@link RuntimeConfig.minReachPerDay} — a signal it is worth reacting to
 * immediately rather than waiting for it to become a long-running "winner".
 */
export type NotificationReason = "new" | "winner" | "rising";

/**
 * A single notification payload item — one ad worth telling the user about.
 */
export interface NotificationItem {
  reason: NotificationReason;
  ad: StoredAd;
  /** Days the ad has been running, computed at notification time. */
  daysRunning: number;
}

/**
 * Supported outbound notification channels.
 */
export type WebhookKind = "slack" | "discord";

/**
 * Fully-resolved runtime configuration, after merging CLI flags and env vars.
 */
export interface RuntimeConfig {
  /** The Facebook page id OR a full Ad Library URL. */
  pageId: string;
  /** The resolved Ad Library URL we will actually navigate to. */
  targetUrl: string;
  /** ISO country code passed to the Ad Library (e.g. "US", "ALL"). */
  country: string;
  /** Where the snapshot JSON lives. */
  dataFile: string;
  /** Days an ad must run before it counts as a "winner". */
  winnerThresholdDays: number;
  /**
   * Above this EU reach-per-day, a brand-new ad (see
   * {@link newAdMaxAgeDays}) is flagged as a "rising" winner instead of a
   * plain "new" ad — worth reacting to right away.
   */
  minReachPerDay: number;
  /** Max age (days) for a "new" ad to still be eligible for EU reach checks / "rising" classification. */
  newAdMaxAgeDays: number;
  /**
   * Countries (as they appear in the EU transparency panel, e.g. "France")
   * that count toward the "rising" reach/day computation. An ad's reach in
   * countries outside this list is still recorded but not counted — keeps
   * the urgent channel scoped to markets we actually sell into.
   */
  targetCountries: string[];
  /** Consecutive daily checks a candidate must clear {@link minReachPerDay} in before it's confirmed "rising". */
  risingConfirmDays: number;
  /** Discord webhook for the second ("new products", non-Ampoule) channel, if configured. */
  discordWebhookUrlNewProducts: string | null;
  /**
   * When set, this run searches the Ad Library by free-text keyword (see
   * {@link resolveDiscoveryUrl}) instead of tracking one known page — used to
   * discover unknown/new competitors rather than re-check known ones.
   */
  discoveryKeyword: string | null;
  /**
   * Advertiser names to drop from the results entirely, matched
   * case-insensitively against {@link Ad.pageName}. Used in keyword-discovery
   * mode so already-tracked competitors (who have their own dedicated page
   * job) don't get double-reported here too.
   */
  excludePageNames: string[];
  /** Max number of infinite-scroll passes before we give up. */
  maxScrolls: number;
  /** Run the browser headless? */
  headless: boolean;
  /** Slack incoming webhook URL, if configured. */
  slackWebhookUrl: string | null;
  /** Discord webhook URL, if configured. */
  discordWebhookUrl: string | null;
  /** Skip every outbound notification (dry run). */
  dryRun: boolean;
  /** Per-navigation timeout in milliseconds. */
  navigationTimeoutMs: number;
}
