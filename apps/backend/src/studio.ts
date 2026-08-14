import { existsSync, readFileSync } from "node:fs";
import { parse } from "yaml";
import * as z from "zod";

/** A string this Studio publishes about itself, in each language it serves. */
const localizedText = z
  .object({ en: z.string().default(""), ru: z.string().default("") })
  .strict()
  .prefault({});

const profileList = z
  .array(z.object({ label: z.string().min(1), url: z.url() }).strict())
  .default([])
  .describe("social profiles listed in llms.txt and the home page's sameAs");

const studioSchema = z
  .object({
    timezone: z.string().default("Europe/Moscow"),
    timezone_label: z.string().default("MSK"),
    site_enabled: z.boolean().default(true),
    // Who this Studio publishes as. Empty is a working site that simply names
    // itself by its domain — the alternative was shipping one person's name,
    // biography and social accounts to everyone who installs the image.
    site: z
      .object({
        name: localizedText,
        tagline: localizedText,
        about: localizedText,
        profiles: z.object({ en: profileList, ru: profileList }).strict().prefault({}),
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
  /** What this Studio says it is, resolved per language. */
  site: (locale: "en" | "ru") => { name: string; tagline: string; about: string; profiles: { label: string; url: string }[] };
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
    site: (locale) => ({
      name: parsed.site.name[locale],
      tagline: parsed.site.tagline[locale],
      about: parsed.site.about[locale],
      profiles: parsed.site.profiles[locale],
    }),
    video: parsed.video,
  };
}
