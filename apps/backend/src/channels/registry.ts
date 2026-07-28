import { and, eq } from "drizzle-orm";
import type { BackendDb } from "../db/client.js";
import { channelConnections } from "../db/schema.js";
import type { BackendConfig } from "../foundation/config.js";
import type { VideoLocale } from "../foundation/external/youtube.js";
import type { VideoTarget } from "../publishing/video-types.js";

export type ChannelConnection = typeof channelConnections.$inferSelect;
export type ChannelSeed = Omit<ChannelConnection, "createdAt" | "updatedAt">;

function channelId(platform: string, locale: VideoLocale): string {
  return `${platform}_${locale}`;
}

export function configuredChannels(config: BackendConfig): ChannelSeed[] {
  const seeds: ChannelSeed[] = configuredPostChannels(config);
  if (config.studio.modules.youtube) {
    if (config.YOUTUBE_CLIENT_ID && config.YOUTUBE_CLIENT_SECRET && config.YOUTUBE_REFRESH_TOKEN)
      seeds.push(seed("youtube", "ru", "native"));
    if (config.YOUTUBE_EN_CLIENT_ID && config.YOUTUBE_EN_CLIENT_SECRET && config.YOUTUBE_EN_REFRESH_TOKEN)
      seeds.push(seed("youtube", "en", "native"));
  }
  if (config.studio.modules.instagram) {
    for (const locale of ["ru", "en"] as const) {
      const route = config.PUBLISH_PROVIDER_ROUTES_JSON[locale === "en" ? "instagram_reels_en" : "instagram_reels"];
      if (route?.provider === "zernio" && route.accountId) seeds.push(seed("instagram", locale, "zernio", route.accountId));
      else if (locale === "ru" && config.INSTAGRAM_ACCESS_TOKEN && config.INSTAGRAM_USER_ID)
        seeds.push(seed("instagram", locale, "native", config.INSTAGRAM_USER_ID));
    }
  }
  return seeds;
}

function seed(platform: string, locale: VideoLocale, provider: string, providerAccountId?: string): ChannelSeed {
  return {
    id: channelId(platform, locale),
    platform,
    locale,
    provider,
    providerAccountId: providerAccountId ?? null,
    targetId: null,
    label: `${displayPlatform(platform)} ${locale.toUpperCase()}`,
    enabled: 1,
    source: "config",
  };
}

function configuredPostChannels(config: BackendConfig): ChannelSeed[] {
  if (!config.studio.modules.text_posting) return [];
  const seeds: ChannelSeed[] = [];
  const add = (targetId: string, platform: string, locale: VideoLocale, label: string, provider: string, providerAccountId?: string) =>
    seeds.push({
      id: targetId,
      targetId,
      platform,
      locale,
      provider,
      providerAccountId: providerAccountId ?? null,
      label,
      enabled: 1,
      source: "config",
    });
  if (config.controllerBotToken) add("telegram", "telegram", "ru", "Telegram RU", "native", config.CHANNEL_USERNAME);
  if (config.studio.modules.site) {
    add("site_ru", "site", "ru", "Site RU", "internal");
    add("site_en", "site", "en", "Site EN", "internal");
  }
  if (config.THREADS_ACCESS_TOKEN) add("threads_ru", "threads", "ru", "Threads RU", "native");
  if (config.THREADS_EN_ACCESS_TOKEN) add("threads_en", "threads_en", "en", "Threads EN", "native");
  if (config.X_CONSUMER_KEY && config.X_CONSUMER_SECRET && config.X_ACCESS_TOKEN && config.X_ACCESS_TOKEN_SECRET)
    add("x", "x", "en", "X EN", "native");
  if (config.ENABLE_TELEGRAM_STORIES)
    add("telegram_stories", "telegram_stories", "ru", "Telegram Stories RU", "native", config.TELEGRAM_STORIES_CHANNEL);
  if (config.ENABLE_INSTAGRAM_STORIES) {
    if (config.INSTAGRAM_RU_ACCESS_TOKEN && config.INSTAGRAM_RU_USER_ID)
      add("instagram_stories_ru", "instagram_stories", "ru", "Instagram Stories RU", "native", config.INSTAGRAM_RU_USER_ID);
    if (config.INSTAGRAM_EN_ACCESS_TOKEN && config.INSTAGRAM_EN_USER_ID)
      add("instagram_stories", "instagram_stories", "en", "Instagram Stories EN", "native", config.INSTAGRAM_EN_USER_ID);
  }
  return seeds;
}

export function bootstrapConfiguredChannels(backendDb: BackendDb, config: BackendConfig): ChannelConnection[] {
  const now = new Date().toISOString();
  const configured = configuredChannels(config);
  const configuredIds = new Set(configured.map((connection) => connection.id));
  for (const existing of listChannels(backendDb, false))
    if (existing.source === "config" && !configuredIds.has(existing.id))
      backendDb.db.update(channelConnections).set({ enabled: 0, updatedAt: now }).where(eq(channelConnections.id, existing.id)).run();
  for (const connection of configured) {
    const existing = backendDb.db.select().from(channelConnections).where(eq(channelConnections.id, connection.id)).get();
    // An account explicitly selected in an interface overrides the bootstrap
    // route until that connection is disabled or replaced there.
    if (existing && existing.source !== "config") continue;
    backendDb.db
      .insert(channelConnections)
      .values({ ...connection, createdAt: now, updatedAt: now })
      .onConflictDoUpdate({
        target: channelConnections.id,
        set: {
          platform: connection.platform,
          locale: connection.locale,
          provider: connection.provider,
          providerAccountId: connection.providerAccountId,
          targetId: connection.targetId,
          enabled: 1,
          updatedAt: now,
        },
      })
      .run();
  }
  return listChannels(backendDb);
}

export function listChannels(backendDb: BackendDb, enabledOnly = true): ChannelConnection[] {
  const query = backendDb.db.select().from(channelConnections);
  return (enabledOnly ? query.where(eq(channelConnections.enabled, 1)) : query)
    .all()
    .sort((left, right) => left.platform.localeCompare(right.platform) || left.locale.localeCompare(right.locale));
}

export function registerChannel(
  backendDb: BackendDb,
  input: {
    platform: string;
    locale: VideoLocale;
    provider: string;
    providerAccountId?: string;
    targetId?: string;
    label?: string;
    source?: string;
  },
): ChannelConnection {
  const now = new Date().toISOString();
  const id = channelId(input.platform, input.locale);
  backendDb.db
    .insert(channelConnections)
    .values({
      id,
      platform: input.platform,
      locale: input.locale,
      provider: input.provider,
      providerAccountId: input.providerAccountId ?? null,
      targetId: input.targetId ?? null,
      label: input.label ?? `${displayPlatform(input.platform)} ${input.locale.toUpperCase()}`,
      enabled: 1,
      source: input.source ?? "interface",
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: channelConnections.id,
      set: {
        provider: input.provider,
        providerAccountId: input.providerAccountId ?? null,
        targetId: input.targetId ?? null,
        label: input.label ?? `${displayPlatform(input.platform)} ${input.locale.toUpperCase()}`,
        enabled: 1,
        source: input.source ?? "interface",
        updatedAt: now,
      },
    })
    .run();
  const connection = backendDb.db.select().from(channelConnections).where(eq(channelConnections.id, id)).get();
  if (!connection) throw new Error(`Channel registration did not persist: ${id}`);
  return connection;
}

export function registeredPostTargetIds(backendDb: BackendDb): Set<string> {
  return new Set(
    listChannels(backendDb)
      .map((connection) => connection.targetId)
      .filter((target): target is string => Boolean(target)),
  );
}

/** Filters a persisted target map only when this installation has bootstrapped
 * post channels. Empty registries keep legacy and fixture databases compatible. */
export function effectivePostTargets(backendDb: BackendDb, targets: Record<string, boolean>): Record<string, boolean> {
  const registered = registeredPostTargetIds(backendDb);
  if (!registered.size) return { ...targets };
  return Object.fromEntries(Object.entries(targets).map(([target, enabled]) => [target, enabled && registered.has(target)]));
}

export function channelForVideo(backendDb: BackendDb, target: VideoTarget, locale: VideoLocale): ChannelConnection | undefined {
  const platform = target === "youtube_shorts" ? "youtube" : "instagram";
  return backendDb.db
    .select()
    .from(channelConnections)
    .where(and(eq(channelConnections.platform, platform), eq(channelConnections.locale, locale), eq(channelConnections.enabled, 1)))
    .get();
}

function displayPlatform(platform: string): string {
  return platform === "youtube" ? "YouTube" : platform === "instagram" ? "Instagram" : platform[0]?.toUpperCase() + platform.slice(1);
}
