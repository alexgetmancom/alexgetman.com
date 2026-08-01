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

/** Resolves one Instagram account while retaining the shared-credential fallback. */
export function instagramCredentialsForLocale(config: InstagramCredentialSource, locale: InstagramLocale): InstagramCredentials {
  return locale === "en"
    ? {
        accessToken: config.INSTAGRAM_EN_ACCESS_TOKEN ?? config.INSTAGRAM_ACCESS_TOKEN,
        userId: config.INSTAGRAM_EN_USER_ID ?? config.INSTAGRAM_USER_ID,
      }
    : {
        accessToken: config.INSTAGRAM_RU_ACCESS_TOKEN ?? config.INSTAGRAM_ACCESS_TOKEN,
        userId: config.INSTAGRAM_RU_USER_ID ?? config.INSTAGRAM_USER_ID,
      };
}

/** Adapts the legacy Instagram publisher interface to one locale's account. */
export function instagramConfigForLocale<T extends InstagramCredentialSource>(config: T, locale: InstagramLocale): T {
  const credentials = instagramCredentialsForLocale(config, locale);
  return {
    ...config,
    INSTAGRAM_ACCESS_TOKEN: credentials.accessToken,
    INSTAGRAM_USER_ID: credentials.userId,
  } as T;
}
