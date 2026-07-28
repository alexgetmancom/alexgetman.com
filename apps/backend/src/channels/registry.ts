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
  const seeds: ChannelSeed[] = [];
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
    label: `${displayPlatform(platform)} ${locale.toUpperCase()}`,
    enabled: 1,
    source: "config",
  };
}

export function bootstrapConfiguredChannels(backendDb: BackendDb, config: BackendConfig): ChannelConnection[] {
  const now = new Date().toISOString();
  for (const connection of configuredChannels(config)) {
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
