import { existsSync, readFileSync } from "node:fs";
import { parse } from "yaml";
import * as z from "zod";

const studioSchema = z
  .object({
    timezone: z.string().default("Europe/Moscow"),
    timezone_label: z.string().default("MSK"),
    site_enabled: z.boolean().default(true),
    analytics: z
      .object({
        /** First analytics card to open. This is a Studio decision, not a UI guess. */
        default_tab: z.enum(["overview", "posts", "video"]).default("overview"),
      })
      .strict()
      .prefault({}),
    video: z
      .object({
        prepare_lead_minutes: z.number().int().min(1).max(120).default(15),
        reminder_minutes: z.number().int().min(1).max(60).default(5),
        retention_hours: z.number().int().min(24).max(720).default(24),
      })
      .strict()
      .prefault({}),
  })
  .strict();

export type StudioConfig = {
  timezone: string;
  timezoneLabel: string;
  siteEnabled: boolean;
  analytics: { defaultTab: "overview" | "posts" | "video" };
  video: { prepare_lead_minutes: number; reminder_minutes: number; retention_hours: number };
};

export function loadStudioConfig(path = process.env.STUDIO_CONFIG ?? "studio.yaml"): StudioConfig {
  const value = existsSync(path) ? parse(readFileSync(path, "utf8")) : {};
  // The schema is the single source of every default; this function only
  // renames snake_case config keys to the camelCase the app reads.
  const parsed = studioSchema.parse(value ?? {});
  return {
    timezone: parsed.timezone,
    timezoneLabel: parsed.timezone_label,
    siteEnabled: parsed.site_enabled,
    analytics: { defaultTab: parsed.analytics.default_tab },
    video: parsed.video,
  };
}
