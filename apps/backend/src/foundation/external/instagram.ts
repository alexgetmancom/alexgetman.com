type InstagramLocale = "ru" | "en";

type InstagramCredentialSource = {
  INSTAGRAM_EN_ACCESS_TOKEN?: string | undefined;
  INSTAGRAM_EN_USER_ID?: string | undefined;
  INSTAGRAM_RU_ACCESS_TOKEN?: string | undefined;
  INSTAGRAM_RU_USER_ID?: string | undefined;
};

export type InstagramCredentials = { accessToken: string | undefined; userId: string | undefined };

export function instagramCredentialsForLocale(config: InstagramCredentialSource, locale: InstagramLocale): InstagramCredentials {
  if (locale === "ru")
    return {
      accessToken: config.INSTAGRAM_RU_ACCESS_TOKEN,
      userId: config.INSTAGRAM_RU_USER_ID,
    };
  return {
    accessToken: config.INSTAGRAM_EN_ACCESS_TOKEN,
    userId: config.INSTAGRAM_EN_USER_ID,
  };
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
