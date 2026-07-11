import * as z from "zod";

export const postLanguageSchema = z.enum(["ru", "en"]);
export type PostLanguage = z.infer<typeof postLanguageSchema>;

export const socialTargetSchema = z.enum([
  "telegram",
  "threads_ru",
  "facebook_ru",
  "linkedin",
  "facebook",
  "threads_en",
  "x",
  "bluesky",
  "devto",
  "mastodon",
  "github_en",
  "github_ru",
  "telegram_stories",
  "instagram_stories_ru",
  "instagram_stories",
]);
export type SocialTarget = z.infer<typeof socialTargetSchema>;

export const socialTargetConfigSchema = z.object({
  id: socialTargetSchema,
  label: z.string(),
  language: postLanguageSchema,
  requiresMedia: z.boolean().default(false),
  enabledByDefault: z.boolean().default(false),
  requiredEnv: z.array(z.string()).default([]),
});
export type SocialTargetConfig = z.infer<typeof socialTargetConfigSchema>;

export const socialTargets: SocialTargetConfig[] = z.array(socialTargetConfigSchema).parse([
  { id: "telegram", label: "Telegram", language: "ru", enabledByDefault: true, requiredEnv: ["CONTROLLER_BOT_TOKEN"] },
  { id: "threads_ru", label: "Threads RU", language: "ru", enabledByDefault: true, requiredEnv: ["THREADS_ACCESS_TOKEN"] },
  {
    id: "facebook_ru",
    label: "Facebook RU",
    language: "ru",
    enabledByDefault: false,
    requiredEnv: ["FACEBOOK_RU_PAGE_ID", "FACEBOOK_RU_PAGE_ACCESS_TOKEN"],
  },
  {
    id: "linkedin",
    label: "LinkedIn",
    language: "en",
    enabledByDefault: false,
    requiredEnv: ["LINKEDIN_AUTHOR_URN", "LINKEDIN_ACCESS_TOKEN"],
  },
  {
    id: "facebook",
    label: "Facebook EN",
    language: "en",
    enabledByDefault: false,
    requiredEnv: ["FACEBOOK_PAGE_ID", "FACEBOOK_PAGE_ACCESS_TOKEN"],
  },
  { id: "threads_en", label: "Threads EN", language: "en", enabledByDefault: true, requiredEnv: ["THREADS_EN_ACCESS_TOKEN"] },
  { id: "x", label: "X", language: "en", enabledByDefault: false, requiredEnv: ["X_ACCESS_TOKEN"] },
  { id: "bluesky", label: "Bluesky", language: "en", enabledByDefault: false, requiredEnv: ["BLUESKY_IDENTIFIER", "BLUESKY_APP_PASSWORD"] },
  { id: "devto", label: "Dev.to", language: "en", enabledByDefault: false, requiredEnv: ["DEVTO_API_KEY"] },
  { id: "mastodon", label: "Mastodon", language: "en", enabledByDefault: false, requiredEnv: ["MASTODON_ACCESS_TOKEN"] },
  { id: "github_en", label: "GitHub EN", language: "en", enabledByDefault: false, requiredEnv: ["GITHUB_DISCUSSIONS_TOKEN"] },
  { id: "github_ru", label: "GitHub RU", language: "ru", enabledByDefault: false, requiredEnv: ["GITHUB_DISCUSSIONS_TOKEN"] },
  {
    id: "telegram_stories",
    label: "Telegram Stories",
    language: "ru",
    enabledByDefault: false,
    requiredEnv: ["TELEGRAM_CHANNEL_STORIES_API_ID", "TELEGRAM_CHANNEL_STORIES_API_HASH"],
  },
  {
    id: "instagram_stories_ru",
    label: "Instagram Stories RU",
    language: "ru",
    enabledByDefault: false,
    requiredEnv: ["INSTAGRAM_RU_USER_ID", "INSTAGRAM_RU_ACCESS_TOKEN"],
  },
  {
    id: "instagram_stories",
    label: "Instagram Stories EN",
    language: "en",
    enabledByDefault: false,
    requiredEnv: ["INSTAGRAM_EN_USER_ID", "INSTAGRAM_EN_ACCESS_TOKEN"],
  },
]);
