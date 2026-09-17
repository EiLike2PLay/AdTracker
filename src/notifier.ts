/**
 * notifier.ts
 * -------------------------------------------------------------------------
 * Outbound notifications for AdRadar.
 *
 * Takes the {@link NotificationItem}s produced by the diff and renders them as
 * rich messages for Slack (Block Kit) and/or Discord (Embeds), then POSTs them
 * to the configured incoming webhooks with axios.
 *
 * Both transports are best-effort and isolated: a failure delivering to Slack
 * never blocks Discord, and a single oversized payload is chunked so we stay
 * under each platform's block/embed limits.
 * -------------------------------------------------------------------------
 */

import axios, { AxiosError } from "axios";
import { computeDaysRunning } from "./storage.js";
import { looksLikeAmpouleProduct } from "./classify.js";
import type {
  NotificationItem,
  RuntimeConfig,
  StoredAd,
} from "./types.js";

/** Slack hard-caps a message at 50 blocks; Discord at 10 embeds. */
const SLACK_MAX_ADS_PER_MESSAGE = 8;
const DISCORD_MAX_EMBEDS = 10;

/** Network timeout for webhook delivery. */
const WEBHOOK_TIMEOUT_MS = 15000;

export interface NotifyOutcome {
  slackSent: number;
  discordSent: number;
  errors: string[];
}

/**
 * Build the notification items to actually push out. Deliberately narrow:
 * a plain "new" sighting is not validated by any vuistregel yet, so it is
 * never included here — only a confirmed "winner" (≥ winnerThresholdDays,
 * see {@link reconcile}) or a confirmed "rising" ad (risingConfirmDays
 * consecutive days ≥ minReachPerDay, see the orchestration in index.ts)
 * has cleared a rule and is worth a notification.
 */
export function buildNotificationItems(
  winners: StoredAd[],
  rising: StoredAd[] = [],
  nowIso: string = new Date().toISOString(),
): NotificationItem[] {
  const items: NotificationItem[] = [];

  for (const ad of rising) {
    items.push({ reason: "rising", ad, daysRunning: computeDaysRunning(ad, nowIso) });
  }
  for (const ad of winners) {
    items.push({ reason: "winner", ad, daysRunning: computeDaysRunning(ad, nowIso) });
  }

  return items;
}

/**
 * Deliver all items to every configured channel. Never throws — all failures
 * are collected into {@link NotifyOutcome.errors}.
 */
export async function notify(
  items: NotificationItem[],
  config: RuntimeConfig,
): Promise<NotifyOutcome> {
  const outcome: NotifyOutcome = { slackSent: 0, discordSent: 0, errors: [] };

  if (items.length === 0) return outcome;

  if (config.dryRun) {
    outcome.errors.push("dry-run: notifications suppressed");
    return outcome;
  }

  if (config.slackWebhookUrl) {
    try {
      outcome.slackSent = await sendSlack(
        items,
        config.slackWebhookUrl,
        config,
      );
    } catch (err) {
      outcome.errors.push(`slack: ${describeError(err)}`);
    }
  }

  // Route to two Discord channels: the Ampoule-specific one (any ad whose
  // copy matches a known angle / product keyword) and a "new products"
  // catch-all for everything else. When only one webhook is configured,
  // everything goes there rather than silently dropping the other half.
  if (config.discordWebhookUrl || config.discordWebhookUrlNewProducts) {
    const ampoule = items.filter((i) => looksLikeAmpouleProduct(i.ad.text));
    const other = items.filter((i) => !looksLikeAmpouleProduct(i.ad.text));

    const ampouleWebhook = config.discordWebhookUrl;
    const otherWebhook = config.discordWebhookUrlNewProducts ?? config.discordWebhookUrl;

    try {
      if (ampouleWebhook && ampoule.length > 0) {
        outcome.discordSent += await sendDiscord(ampoule, ampouleWebhook, config);
      }
      // Avoid double-sending "other" items to the same webhook as "ampoule"
      // when there's only one configured — they were already included above
      // only if ampouleWebhook === otherWebhook and ampoule.length > 0 would
      // miss `other`, so send them explicitly whenever a webhook exists.
      if (otherWebhook && other.length > 0) {
        outcome.discordSent += await sendDiscord(other, otherWebhook, config);
      }
    } catch (err) {
      outcome.errors.push(`discord: ${describeError(err)}`);
    }
  }

  if (!config.slackWebhookUrl && !config.discordWebhookUrl && !config.discordWebhookUrlNewProducts) {
    outcome.errors.push(
      "no webhook configured (set SLACK_WEBHOOK_URL or DISCORD_WEBHOOK_URL)",
    );
  }

  return outcome;
}

/* ====================================================================== *
 *  SLACK — Block Kit                                                      *
 * ====================================================================== */

interface SlackBlock {
  type: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

async function sendSlack(
  items: NotificationItem[],
  webhookUrl: string,
  config: RuntimeConfig,
): Promise<number> {
  let sent = 0;
  for (const chunk of chunkArray(items, SLACK_MAX_ADS_PER_MESSAGE)) {
    const blocks = buildSlackBlocks(chunk, config);
    await axios.post(
      webhookUrl,
      { blocks, unfurl_links: false, unfurl_media: false },
      {
        timeout: WEBHOOK_TIMEOUT_MS,
        headers: { "Content-Type": "application/json" },
      },
    );
    sent += chunk.length;
  }
  return sent;
}

function buildSlackBlocks(
  items: NotificationItem[],
  config: RuntimeConfig,
): SlackBlock[] {
  const blocks: SlackBlock[] = [];

  const newCount = items.filter((i) => i.reason === "new").length;
  const risingCount = items.filter((i) => i.reason === "rising").length;
  const winnerCount = items.filter((i) => i.reason === "winner").length;

  blocks.push({
    type: "header",
    text: {
      type: "plain_text",
      text: `📡 AdRadar — ${newCount} new · ${risingCount} rising · ${winnerCount} winner${winnerCount === 1 ? "" : "s"}`,
      emoji: true,
    },
  });

  blocks.push({
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        text: `Tracking page \`${config.pageId}\` · winner threshold *${config.winnerThresholdDays}d*`,
      },
    ],
  });

  blocks.push({ type: "divider" });

  for (const item of items) {
    const { ad, reason, daysRunning } = item;
    const badge =
      reason === "winner"
        ? "🏆 *LONG-RUNNING WINNER*"
        : reason === "rising"
          ? "🚀 *RISING WINNER*"
          : "🆕 *NEW AD*";
    const advertiser = ad.pageName ? ` · *${escapeSlack(ad.pageName)}*` : "";
    const started = ad.startedRunningRaw
      ? escapeSlack(ad.startedRunningRaw)
      : "start date unknown";

    const copy = escapeSlack(ad.hook ?? truncate(ad.text || "(geen tekst gevonden)", 150));
    const euLine = buildEuLine(ad, daysRunning);
    const angleLine = ad.angles && ad.angles.length > 0 ? `🎯 ${escapeSlack(ad.angles.join(", "))}` : null;

    const section: SlackBlock = {
      type: "section",
      text: {
        type: "mrkdwn",
        text: [
          `${badge}${advertiser}`,
          `> ${copy}`,
          `🗓️ ${started}  ·  ⏱️ running *${daysRunning}d*  ·  ${describeMediaType(ad)}  ·  \`${ad.adId}\``,
          ...(angleLine ? [angleLine] : []),
          ...(euLine ? [euLine] : []),
        ].join("\n"),
      },
    };

    const thumb = pickThumbnail(ad);
    if (thumb) {
      section.accessory = {
        type: "image",
        image_url: thumb,
        alt_text: ad.pageName ? `${ad.pageName} creative` : "ad creative",
      };
    }

    blocks.push(section);

    if (ad.adLibraryUrl) {
      blocks.push({
        type: "actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "🔗 Open in Ad Library", emoji: true },
            url: ad.adLibraryUrl,
          },
        ],
      });
    }

    blocks.push({ type: "divider" });
  }

  return blocks;
}

/* ====================================================================== *
 *  DISCORD — Embeds                                                       *
 * ====================================================================== */

interface DiscordEmbed {
  title: string;
  description?: string;
  url?: string;
  color: number;
  timestamp?: string;
  footer?: { text: string };
  author?: { name: string };
  fields?: Array<{ name: string; value: string; inline?: boolean }>;
  image?: { url: string };
  thumbnail?: { url: string };
}

async function sendDiscord(
  items: NotificationItem[],
  webhookUrl: string,
  config: RuntimeConfig,
): Promise<number> {
  let sent = 0;
  for (const chunk of chunkArray(items, DISCORD_MAX_EMBEDS)) {
    const embeds = chunk.map((item) => buildDiscordEmbed(item, config));
    await axios.post(
      webhookUrl,
      {
        username: "AdRadar",
        content: discordSummaryLine(chunk, config),
        embeds,
      },
      {
        timeout: WEBHOOK_TIMEOUT_MS,
        headers: { "Content-Type": "application/json" },
      },
    );
    sent += chunk.length;
  }
  return sent;
}

function discordSummaryLine(
  items: NotificationItem[],
  config: RuntimeConfig,
): string {
  const newCount = items.filter((i) => i.reason === "new").length;
  const risingCount = items.filter((i) => i.reason === "rising").length;
  const winnerCount = items.filter((i) => i.reason === "winner").length;
  return `📡 **AdRadar** — ${newCount} new · ${risingCount} rising · ${winnerCount} winner(s) for page \`${config.pageId}\``;
}

function buildDiscordEmbed(
  item: NotificationItem,
  config: RuntimeConfig,
): DiscordEmbed {
  const { ad, reason, daysRunning } = item;

  const title =
    reason === "winner"
      ? "🏆 Long-running winner"
      : reason === "rising"
        ? "🚀 Rising winner"
        : "🆕 New ad detected";
  const color =
    reason === "winner" ? 0xf5a623 /* gold */ : reason === "rising" ? 0xe74c3c /* red */ : 0x2eb67d /* green */;

  // Keep the description to a short, scannable teaser — the hook (already
  // just the opening sentence) instead of the full ad copy, which runs in
  // whatever language the ad targets (often French) and can be 1000+ chars.
  const description = ad.hook ?? truncate(ad.text || "(geen tekst gevonden)", 150);

  const embed: DiscordEmbed = {
    title,
    color,
    description,
    timestamp: new Date().toISOString(),
    footer: {
      text: `winner ≥ ${config.winnerThresholdDays}d · rising ≥ ${config.minReachPerDay}/d`,
    },
    fields: [
      ...(ad.adLibraryUrl
        ? [{ name: "🔗 Ad", value: `[Bekijk in Ad Library](${ad.adLibraryUrl})`, inline: false }]
        : []),
      {
        name: "Looptijd",
        value: `${daysRunning}d (sinds ${ad.startedRunningRaw?.replace("Started running on ", "") ?? "onbekend"})`,
        inline: true,
      },
      {
        name: "Media",
        value: describeMediaType(ad),
        inline: true,
      },
      ...(ad.angles && ad.angles.length > 0
        ? [{ name: "Angle", value: ad.angles.join(", "), inline: false }]
        : []),
      ...buildEuFields(ad, daysRunning),
      {
        name: "Ad ID",
        value: `\`${ad.adId}\``,
        inline: true,
      },
    ],
  };

  if (ad.pageName) embed.author = { name: ad.pageName };
  if (ad.adLibraryUrl) embed.url = ad.adLibraryUrl;

  const thumb = pickThumbnail(ad);
  if (thumb) embed.image = { url: thumb };

  return embed;
}

/* ====================================================================== *
 *  Shared helpers                                                         *
 * ====================================================================== */

/**
 * Choose the best preview image for an ad: a real image first, then a video's
 * poster frame, then any media URL as a last resort.
 */
/**
 * Summarize how many video vs. image assets an ad uses (an ad can carry
 * several creative variants), e.g. "🎬 Video" or "🖼️ Image + 🎬 Video".
 */
function describeMediaType(ad: StoredAd): string {
  const hasVideo = ad.media.some((m) => m.type === "video");
  const hasImage = ad.media.some((m) => m.type === "image");
  if (hasVideo && hasImage) return "🖼️ Image + 🎬 Video";
  if (hasVideo) return "🎬 Video";
  if (hasImage) return "🖼️ Static image";
  return "❓ Unknown";
}

/**
 * Discord embed fields for EU reach data, when we have it. Absent entirely
 * for ads we never checked (existing winners) or that were never shown in
 * the EU — no point rendering "n/a" everywhere.
 */
/**
 * Average reach/day: prefers the mean of the daily, target-country-scoped
 * {@link StoredAd.reachHistory} readings (what actually drove a "rising"
 * confirmation) over the cruder lifetime average (total reach / days
 * running), which is unscoped and can include countries we don't sell into.
 */
function averageReachPerDay(ad: StoredAd, daysRunning: number): number {
  if (ad.reachHistory && ad.reachHistory.length > 0) {
    const sum = ad.reachHistory.reduce((acc, h) => acc + h.reachPerDay, 0);
    return Math.round(sum / ad.reachHistory.length);
  }
  return Math.round((ad.euReach ?? 0) / Math.max(1, daysRunning));
}

function buildEuFields(
  ad: StoredAd,
  daysRunning: number,
): Array<{ name: string; value: string; inline?: boolean }> {
  if (typeof ad.euReach !== "number") return [];
  const fields: Array<{ name: string; value: string; inline?: boolean }> = [
    { name: "Reach totaal (EU)", value: ad.euReach.toLocaleString(), inline: true },
    { name: "Reach gemiddeld/dag", value: averageReachPerDay(ad, daysRunning).toLocaleString(), inline: true },
  ];
  if (ad.euCountries && ad.euCountries.length > 0) {
    fields.push({ name: "Land(en)", value: ad.euCountries.join(", "), inline: true });
  }
  if (ad.euTopSegment) {
    fields.push({ name: "Top doelgroep", value: ad.euTopSegment, inline: false });
  }
  return fields;
}

/** One-line Slack equivalent of {@link buildEuFields}. */
function buildEuLine(ad: StoredAd, daysRunning: number): string | null {
  if (typeof ad.euReach !== "number") return null;
  const avg = averageReachPerDay(ad, daysRunning);
  const countries = ad.euCountries && ad.euCountries.length > 0 ? ad.euCountries.join(", ") : "onbekend";
  return `🇪🇺 totaal *${ad.euReach.toLocaleString()}* · gemiddeld *${avg.toLocaleString()}*/dag · ${countries}`;
}

function pickThumbnail(ad: StoredAd): string | null {
  const image = ad.media.find((m) => m.type === "image");
  if (image) return image.url;

  const videoWithPoster = ad.media.find(
    (m) => m.type === "video" && m.thumbnailUrl,
  );
  if (videoWithPoster?.thumbnailUrl) return videoWithPoster.thumbnailUrl;

  const any = ad.media[0];
  return any ? any.thumbnailUrl ?? any.url : null;
}

function chunkArray<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

/** Escape Slack mrkdwn control characters. */
function escapeSlack(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function describeError(err: unknown): string {
  if (axios.isAxiosError(err)) {
    const ax = err as AxiosError;
    const status = ax.response?.status;
    const body =
      typeof ax.response?.data === "string"
        ? ax.response.data
        : JSON.stringify(ax.response?.data ?? {});
    return `HTTP ${status ?? "?"} ${ax.message} ${body}`.trim();
  }
  if (err instanceof Error) return err.message;
  return String(err);
}
