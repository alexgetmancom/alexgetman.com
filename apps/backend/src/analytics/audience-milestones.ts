import { eq } from "drizzle-orm";
import { type ChannelConnection, listChannels } from "../channels/registry.js";
import type { BackendDb } from "../db/client.js";
import { alertDedup, analyticsRollups, creatorProfiles } from "../db/schema.js";
import { recordDomainEvent } from "../domain/events.js";
import { type AudienceGroup, audienceGroup } from "./audience-groups.js";
import { metricNumber } from "./snapshots/creator-store.js";

const FOLLOWER_MILESTONES = [100, 250, 500, 1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 9000, 10_000] as const;
const ROLLUP_PREFIX = "audience_milestone:";

type AudienceEntry = {
  id: string;
  label: string;
  locale: "ru" | "en";
  group: AudienceGroup;
  followers: number;
  isNew: boolean;
};

type MilestoneScope = {
  id: string;
  label: string;
  icon: string;
  target: string;
  entries: AudienceEntry[];
};

/** Evaluates milestones only after every collector in the cycle has had its
 * turn. A channel without durable state is baseline data: its current audience
 * is included in totals, but cannot generate catch-up notifications. */
export function evaluateAudienceMilestones(backendDb: BackendDb): number {
  const entries = audienceEntries(backendDb);
  if (!entries.length) return 0;
  let emitted = 0;
  for (const entry of entries)
    emitted += evaluateScope(backendDb, {
      id: `channel:${entry.id}`,
      label: entry.label,
      icon: "🎉",
      target: entry.id,
      entries: [entry],
    });
  for (const group of ["text", "video"] as const)
    for (const locale of ["ru", "en"] as const)
      emitted += evaluateScope(backendDb, {
        id: `group_locale:${group}:${locale}`,
        label: `${localeIcon(locale)} ${group === "text" ? "Текстовые" : "Видео"} ${locale.toUpperCase()}-каналы`,
        icon: "🏆",
        target: "audience",
        entries: entries.filter((entry) => entry.group === group && entry.locale === locale),
      });
  for (const locale of ["ru", "en"] as const)
    emitted += evaluateScope(backendDb, {
      id: `locale:${locale}`,
      label: `${localeIcon(locale)} Все ${locale.toUpperCase()}-каналы`,
      icon: "🏆",
      target: "audience",
      entries: entries.filter((entry) => entry.locale === locale),
    });
  emitted += evaluateScope(backendDb, {
    id: "project",
    label: "Все площадки",
    icon: "🏆",
    target: "audience",
    entries,
  });
  return emitted;
}

function audienceEntries(backendDb: BackendDb): AudienceEntry[] {
  const profiles = new Map(
    backendDb.db
      .select()
      .from(creatorProfiles)
      .all()
      .map((profile) => [profile.platform, profile]),
  );
  const seen = new Set<string>();
  return listChannels(backendDb).flatMap((connection) => {
    const group = audienceGroup(connection.platform) ?? audienceGroup(connection.id);
    const profile = profiles.get(connection.id) ?? profiles.get(connection.platform);
    if (!group || !profile || seen.has(connection.id)) return [];
    seen.add(connection.id);
    return [
      {
        id: connection.id,
        label: displayLabel(connection),
        locale: connection.locale === "en" ? "en" : "ru",
        group,
        followers: followerCount(profile.dataJson),
        isNew: readState(backendDb, `channel:${connection.id}`) == null,
      },
    ];
  });
}

function evaluateScope(backendDb: BackendDb, scope: MilestoneScope): number {
  if (!scope.entries.length) return 0;
  const current = scope.entries.reduce((sum, entry) => sum + entry.followers, 0);
  const stored = readState(backendDb, scope.id);
  // Adding a channel is not audience growth. Move the comparison baseline by
  // that channel's complete first observation so only later organic growth can
  // cross a threshold.
  const baseline =
    stored == null ? current : stored + scope.entries.filter((entry) => entry.isNew).reduce((sum, entry) => sum + entry.followers, 0);
  markReachedThrough(backendDb, scope.id, baseline);
  let emitted = 0;
  if (current > baseline)
    for (const threshold of FOLLOWER_MILESTONES)
      if (baseline < threshold && current >= threshold && recordMilestone(backendDb, scope, threshold)) emitted += 1;
  writeState(backendDb, scope.id, current);
  return emitted;
}

function recordMilestone(backendDb: BackendDb, scope: MilestoneScope, threshold: number): boolean {
  const key = dedupKey(scope.id, threshold);
  if (backendDb.db.select().from(alertDedup).where(eq(alertDedup.alertKey, key)).get()) return false;
  const now = new Date().toISOString();
  backendDb.db.insert(alertDedup).values({ alertKey: key, lastSentAt: now, suppressedCount: 0 }).run();
  return recordDomainEvent(backendDb.events, {
    type: "analytics.milestone.reached",
    severity: "info",
    target: scope.target,
    message: `${scope.icon} ${scope.label}: ${threshold} подписчиков!`,
    details: { scope: scope.id, threshold },
  });
}

function markReachedThrough(backendDb: BackendDb, scope: string, value: number): void {
  const now = new Date().toISOString();
  for (const threshold of FOLLOWER_MILESTONES) {
    if (threshold > value) break;
    backendDb.db
      .insert(alertDedup)
      .values({ alertKey: dedupKey(scope, threshold), lastSentAt: now, suppressedCount: 0 })
      .onConflictDoNothing()
      .run();
  }
}

function readState(backendDb: BackendDb, scope: string): number | null {
  const row = backendDb.db
    .select({ metricJson: analyticsRollups.metricJson })
    .from(analyticsRollups)
    .where(eq(analyticsRollups.rollupKey, `${ROLLUP_PREFIX}${scope}`))
    .get();
  if (!row) return null;
  try {
    return metricNumber((JSON.parse(row.metricJson) as { followers?: unknown }).followers);
  } catch {
    return null;
  }
}

function writeState(backendDb: BackendDb, scope: string, followers: number): void {
  const now = new Date().toISOString();
  backendDb.db
    .insert(analyticsRollups)
    .values({
      rollupKey: `${ROLLUP_PREFIX}${scope}`,
      scope: "audience_milestone",
      subject: scope,
      metricJson: JSON.stringify({ followers }),
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: analyticsRollups.rollupKey,
      set: { metricJson: JSON.stringify({ followers }), updatedAt: now },
    })
    .run();
}

function followerCount(data: Record<string, unknown>): number {
  return metricNumber(data.subscriberCount ?? data.followersCount);
}

function displayLabel(connection: Pick<ChannelConnection, "label" | "platform" | "locale">): string {
  if (connection.label.trim()) return connection.label;
  const platform =
    connection.platform === "youtube"
      ? "YouTube"
      : connection.platform === "instagram"
        ? "Instagram"
        : connection.platform === "telegram"
          ? "Telegram"
          : connection.platform === "threads" || connection.platform === "threads_en"
            ? "Threads"
            : connection.platform === "x"
              ? "X"
              : connection.platform;
  return `${platform} ${connection.locale.toUpperCase()}`;
}

function localeIcon(locale: "ru" | "en"): string {
  return locale === "ru" ? "🇷🇺" : "🇬🇧";
}

function dedupKey(scope: string, threshold: number): string {
  return `analytics:milestone:v2:${scope}:${threshold}`;
}
