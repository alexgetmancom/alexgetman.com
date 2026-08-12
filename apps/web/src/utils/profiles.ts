import type { SiteLocale } from "./locale";

/** Where this person is on the internet, per locale. One list: the home page's
 * JSON-LD `sameAs` and the llms.txt profile block both read from here, and a
 * changed handle used to mean editing three files and finding out from search
 * results which one was missed. Only Threads differs by locale. */
export function socialProfiles(locale: SiteLocale) {
  return {
    telegram: "https://t.me/alexgetmancom",
    threads: locale === "ru" ? "https://www.threads.net/@alexgetmanru" : "https://www.threads.net/@alexgetmanco",
    youtube: "https://www.youtube.com/@alexgetmancom",
    twitch: "https://www.twitch.tv/alexgetmancom",
    github: "https://github.com/alexgetmancom",
    instagram: "https://www.instagram.com/alexgetmancom/",
    discord: "https://discord.gg/Z7sSm56rcb",
  };
}

/** The `sameAs` array of the Person node, in the order it has always been served. */
export function socialProfileUrls(locale: SiteLocale): string[] {
  const profiles = socialProfiles(locale);
  return [profiles.telegram, profiles.threads, profiles.youtube, profiles.twitch, profiles.github, profiles.instagram, profiles.discord];
}
