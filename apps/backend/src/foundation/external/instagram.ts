export type InstagramLocale = "ru" | "en";

export type InstagramCredentialSource = {
  INSTAGRAM_ACCESS_TOKEN?: string | undefined;
  INSTAGRAM_USER_ID?: string | undefined;
  INSTAGRAM_EN_ACCESS_TOKEN?: string | undefined;
  INSTAGRAM_EN_USER_ID?: string | undefined;
  INSTAGRAM_RU_ACCESS_TOKEN?: string | undefined;
  INSTAGRAM_RU_USER_ID?: string | undefined;
};

export type InstagramCredentials = { accessToken: string | undefined; userId: string | undefined };

/**
 * Whether an unprefixed INSTAGRAM_* pair may stand in for the English account.
 *
 * "none" is the answer everywhere the locale names a real destination. The
 * English fallback exists only for `instagram_stories`, which has meant the
 * English account since before the prefixed variables existed.
 */
export type InstagramSharedFallback = "none" | "shared";

/**
 * Resolves one Instagram account.
 *
 * The unprefixed pair names the *Russian* account: it predates the split, and a
 * Studio that never split has exactly one account, the Russian one. So RU falls
 * back to it and EN does not. Letting EN fall back too invents a second
 * destination out of one real account — it is then seeded as its own channel,
 * snapshotted under its own profile key, and counted twice in the audience
 * panel, while an English draft publishes to the Russian account instead of
 * failing as unconfigured.
 */
export function instagramCredentialsForLocale(
  config: InstagramCredentialSource,
  locale: InstagramLocale,
  fallback: InstagramSharedFallback = "none",
): InstagramCredentials {
  if (locale === "ru")
    return {
      accessToken: config.INSTAGRAM_RU_ACCESS_TOKEN ?? config.INSTAGRAM_ACCESS_TOKEN,
      userId: config.INSTAGRAM_RU_USER_ID ?? config.INSTAGRAM_USER_ID,
    };
  const shared = fallback === "shared";
  return {
    accessToken: config.INSTAGRAM_EN_ACCESS_TOKEN ?? (shared ? config.INSTAGRAM_ACCESS_TOKEN : undefined),
    userId: config.INSTAGRAM_EN_USER_ID ?? (shared ? config.INSTAGRAM_USER_ID : undefined),
  };
}

/** Adapts the legacy Instagram publisher interface to one locale's account. */
export function instagramConfigForLocale<T extends InstagramCredentialSource>(
  config: T,
  locale: InstagramLocale,
  fallback: InstagramSharedFallback = "none",
): T {
  const credentials = instagramCredentialsForLocale(config, locale, fallback);
  return {
    ...config,
    INSTAGRAM_ACCESS_TOKEN: credentials.accessToken,
    INSTAGRAM_USER_ID: credentials.userId,
  } as T;
}

/**
 * Which Graph host answers for a token.
 *
 * Instagram Login tokens (`IG...`) are served by graph.instagram.com; tokens
 * issued through a linked Facebook page are served by graph.facebook.com, and
 * each host rejects the other's token. The two account kinds coexist across
 * locales, so the host is a property of the credential, not of the deployment.
 */
export function instagramGraphHost(token: string): string {
  return token.startsWith("IG") ? "graph.instagram.com" : "graph.facebook.com";
}
