import type { TargetId } from "../botTargets.js";
import type { ZernioAccount } from "../foundation/external/zernio.js";
import type { VideoLocale } from "../publishing/video-types.js";
import type { ChannelInput } from "./registry.js";

export type ZernioConnectionKey = "threads" | "instagram_reels" | "instagram_stories";
export type ZernioConnectionOption = {
  key: ZernioConnectionKey;
  accountId: string;
  locale: VideoLocale;
  label: string;
  input: Omit<ChannelInput, "source">;
};

/** Turns one provider account into only the publication routes this pipeline
 * can actually deliver through Zernio. TikTok remains analytics-only, and
 * YouTube remains native because its worker has no Zernio publisher. */
export function zernioConnectionOptions(account: ZernioAccount, locale: VideoLocale): ZernioConnectionOption[] {
  if (!account._id) return [];
  const platform = zernioPlatform(account);
  const accountLabel = `@${account.username ?? account.displayName ?? account._id}`;
  if (platform === "threads") {
    const targetId = `threads_${locale}` as TargetId;
    return [targetOption("threads", targetId, account._id, locale, `Threads ${locale.toUpperCase()} · ${accountLabel}`)];
  }
  if (platform !== "instagram") return [];
  const storyTarget = (locale === "ru" ? "instagram_stories_ru" : "instagram_stories") as TargetId;
  return [
    {
      key: "instagram_reels",
      accountId: account._id,
      locale,
      label: `Instagram Reels ${locale.toUpperCase()} · ${accountLabel}`,
      input: {
        platform: "instagram",
        locale,
        provider: "zernio",
        providerAccountId: account._id,
        label: `Instagram ${locale.toUpperCase()} · ${accountLabel}`,
      },
    },
    targetOption("instagram_stories", storyTarget, account._id, locale, `Instagram Stories ${locale.toUpperCase()} · ${accountLabel}`),
  ];
}

function targetOption(
  key: ZernioConnectionKey,
  targetId: TargetId,
  accountId: string,
  locale: VideoLocale,
  label: string,
): ZernioConnectionOption {
  return {
    key,
    accountId,
    locale,
    label,
    input: { platform: targetId, locale, provider: "zernio", providerAccountId: accountId, targetId, label },
  };
}

function zernioPlatform(account: ZernioAccount): string {
  const value = account.platform?.trim().toLowerCase() ?? "";
  if (value.includes("threads")) return "threads";
  if (value.includes("instagram")) return "instagram";
  if (value.includes("youtube")) return "youtube";
  if (value.includes("tiktok")) return "tiktok";
  return value;
}
