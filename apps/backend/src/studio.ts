import { existsSync, readFileSync } from "node:fs";
import { parse } from "yaml";
import * as z from "zod";

const studioSchema = z.object({
  timezone: z.string().default("Europe/Moscow"),
  timezone_label: z.string().default("MSK"),
  modules: z
    .object({
      site: z.boolean().default(true),
      text_posting: z.boolean().default(true),
      video_posting: z.boolean().default(false),
      youtube: z.boolean().default(false),
      instagram: z.boolean().default(false),
      analytics: z.boolean().default(true),
    })
    .partial()
    .default({}),
  analytics: z
    .object({
      /** First analytics card to open. This is a Studio decision, not a UI guess. */
      default_tab: z.enum(["overview", "posts", "video"]).default("overview"),
    })
    .partial()
    .default({}),
  video: z
    .object({
      prepare_lead_minutes: z.number().int().min(1).max(120).default(15),
      reminder_minutes: z.number().int().min(1).max(60).default(5),
      retention_hours: z.number().int().min(24).max(720).default(24),
    })
    .partial()
    .default({}),
  command_center: z
    .object({
      /** The initial content view; the other view remains available as a tab. */
      default_mode: z.enum(["posts", "video"]).default("posts"),
    })
    .partial()
    .default({}),
});

export type StudioConfig = {
  timezone: string;
  timezoneLabel: string;
  modules: { site: boolean; text_posting: boolean; video_posting: boolean; youtube: boolean; instagram: boolean; analytics: boolean };
  analytics: { defaultTab: "overview" | "posts" | "video" };
  video: { prepare_lead_minutes: number; reminder_minutes: number; retention_hours: number };
  commandCenter: { defaultMode: "posts" | "video" };
};

export function loadStudioConfig(path = process.env.STUDIO_CONFIG ?? "studio.yaml"): StudioConfig {
  const value = existsSync(path) ? parse(readFileSync(path, "utf8")) : {};
  const parsed = studioSchema.parse(value ?? {});
  return {
    timezone: parsed.timezone,
    timezoneLabel: parsed.timezone_label,
    modules: {
      site: parsed.modules.site ?? true,
      text_posting: parsed.modules.text_posting ?? true,
      video_posting: parsed.modules.video_posting ?? false,
      youtube: parsed.modules.youtube ?? false,
      instagram: parsed.modules.instagram ?? false,
      analytics: parsed.modules.analytics ?? true,
    },
    analytics: { defaultTab: parsed.analytics.default_tab ?? "overview" },
    video: {
      prepare_lead_minutes: parsed.video.prepare_lead_minutes ?? 15,
      reminder_minutes: parsed.video.reminder_minutes ?? 5,
      retention_hours: parsed.video.retention_hours ?? 24,
    },
    commandCenter: { defaultMode: parsed.command_center.default_mode ?? "posts" },
  };
}
