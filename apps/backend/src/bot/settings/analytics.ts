import fs from "node:fs";
import { Menu } from "@grammyjs/menu";
import type { Context } from "grammy";
import { importManualAnalytics, manualThreadsFollowers } from "../../analytics/import-manual-analytics.js";
import { importXAnalyticsCsv } from "../../analytics/import-x-csv.js";
import type { BackendDb } from "../../db/client.js";
import type { BackendConfig } from "../../foundation/config.js";
import { materializeTelegramFile } from "../../foundation/external/telegram-files.js";
import { t } from "../../foundation/i18n/index.js";
import type { StudioLocale } from "../../foundation/locale.js";
import { settingsService } from "../../studio/services/settings.js";
import { clearConversationState } from "../conversation-state.js";
import { ANALYTICS_MENU_ID, backToSettings, beginSettingsInput, THREADS_FOLLOWERS_MENU_ID, X_IMPORT_MENU_ID } from "./shared.js";

export function buildAnalyticsMenu(backendDb: BackendDb): Menu<Context> {
  const threadsFollowers = new Menu<Context>(THREADS_FOLLOWERS_MENU_ID, { autoAnswer: false }).dynamic((ctx, range) => {
    const actorId = Number(ctx.from?.id);
    const locale = settingsService(backendDb).locale(actorId);
    for (const account of ["ru", "en"] as const)
      range.text(t(locale, "settings.threads-edit", { account: account.toUpperCase() }), async (ctx) => {
        beginSettingsInput(backendDb, actorId, "threads_followers", { account });
        await ctx.answerCallbackQuery();
        await ctx.reply(t(locale, "settings.threads-ask", { account: account.toUpperCase() }));
      });
    range.row().back(t(locale, "settings.back-to-analytics"), async (ctx) => {
      clearConversationState(backendDb, actorId, "settings");
      await ctx.answerCallbackQuery();
      await ctx.editMessageText(analyticsText(backendDb, locale), { parse_mode: "Markdown" });
    });
  });

  const xImport = new Menu<Context>(X_IMPORT_MENU_ID, { autoAnswer: false }).dynamic((ctx, range) => {
    const actorId = Number(ctx.from?.id);
    const locale = settingsService(backendDb).locale(actorId);
    range
      .text(t(locale, "settings.x-import-start"), async (ctx) => {
        beginSettingsInput(backendDb, actorId, "x_import");
        await ctx.answerCallbackQuery();
        await ctx.reply(t(locale, "settings.x-import-ask"));
      })
      .row()
      .back(t(locale, "settings.back-to-analytics"), async (ctx) => {
        clearConversationState(backendDb, actorId, "settings");
        await ctx.answerCallbackQuery();
        await ctx.editMessageText(analyticsText(backendDb, locale), { parse_mode: "Markdown" });
      });
  });

  const analytics = new Menu<Context>(ANALYTICS_MENU_ID, { autoAnswer: false }).dynamic((ctx, range) => {
    const locale = settingsService(backendDb).locale(Number(ctx.from?.id));
    range
      .submenu(t(locale, "settings.threads-followers"), THREADS_FOLLOWERS_MENU_ID, async (ctx) => {
        await ctx.answerCallbackQuery();
        await ctx.editMessageText(threadsFollowersText(backendDb, locale), { parse_mode: "Markdown" });
      })
      .row()
      .submenu(t(locale, "settings.x-import"), X_IMPORT_MENU_ID, async (ctx) => {
        await ctx.answerCallbackQuery();
        await ctx.editMessageText(t(locale, "settings.x-import-body"), { parse_mode: "Markdown" });
      })
      .row()
      .back(t(locale, "settings.back-to-settings"), backToSettings(backendDb));
  });
  analytics.register(threadsFollowers);
  analytics.register(xImport);
  return analytics;
}

export function analyticsText(backendDb: BackendDb, locale: StudioLocale): string {
  const followers = manualThreadsFollowers(backendDb);
  const value = (count: number | null) => (count == null ? t(locale, "settings.threads-unknown") : String(count));
  return t(locale, "settings.category-analytics-body", { ru: value(followers.ru), en: value(followers.en) });
}

export async function collectThreadsFollowers(
  ctx: Context,
  backendDb: BackendDb,
  actorId: number,
  text: string,
  settingsMenu: Menu<Context>,
  account: "ru" | "en",
): Promise<boolean> {
  const locale = settingsService(backendDb).locale(actorId);
  const count = Number(text.replace(/[\s,]/gu, ""));
  if (!Number.isSafeInteger(count) || count < 0) {
    await ctx.reply(t(locale, "err.threads-followers-invalid"));
    return true;
  }
  importManualAnalytics(backendDb, {
    sampledAt: messageSampledAt(ctx),
    ...(account === "ru" ? { threadsRuFollowers: count } : { threadsEnFollowers: count }),
  });
  await ctx.reply(t(locale, "settings.threads-saved", { account: account.toUpperCase(), count }));
  await ctx.reply(threadsFollowersText(backendDb, locale), {
    parse_mode: "Markdown",
    reply_markup: settingsMenu.at(THREADS_FOLLOWERS_MENU_ID),
  });
  return true;
}

export async function collectXAnalyticsCsv(
  ctx: Context,
  backendDb: BackendDb,
  config: BackendConfig,
  actorId: number,
  settingsMenu: Menu<Context>,
): Promise<boolean> {
  const locale = settingsService(backendDb).locale(actorId);
  const document = ctx.message && "document" in ctx.message ? ctx.message.document : undefined;
  if (!document) {
    await ctx.reply(t(locale, "settings.x-import-expects-file"));
    return true;
  }
  clearConversationState(backendDb, actorId, "settings");
  if (!/\.csv$/iu.test(document.file_name ?? "")) {
    await ctx.reply(t(locale, "settings.x-import-expects-file"));
    return true;
  }
  const apiFile = await ctx.api.getFile(document.file_id);
  if (!apiFile.file_path) {
    await ctx.reply(t(locale, "settings.x-import-failed", { error: "no file path" }));
    return true;
  }
  const downloaded = await materializeTelegramFile(config, { filePath: apiFile.file_path }, { extension: ".csv" });
  try {
    const result = importXAnalyticsCsv(backendDb, downloaded.path, messageSampledAt(ctx), document.file_name ?? undefined);
    await ctx.reply(
      result.duplicateImport
        ? t(locale, "settings.x-import-duplicate")
        : t(locale, "settings.x-import-done", {
            rows: result.rows,
            items: result.activityItems,
            linked: result.linkedByExternalId + result.linkedByText,
            samples: result.insertedSamples,
          }),
      { parse_mode: "Markdown", reply_markup: settingsMenu.at(X_IMPORT_MENU_ID) },
    );
  } catch (error) {
    await ctx.reply(t(locale, "settings.x-import-failed", { error: error instanceof Error ? error.message : String(error) }));
  } finally {
    if (downloaded.temporary) await fs.promises.rm(downloaded.path, { force: true });
  }
  return true;
}

function threadsFollowersText(backendDb: BackendDb, locale: StudioLocale): string {
  const followers = manualThreadsFollowers(backendDb);
  const value = (count: number | null) => (count == null ? t(locale, "settings.threads-unknown") : String(count));
  return t(locale, "settings.threads-body", {
    ru: value(followers.ru),
    en: value(followers.en),
    updated: followers.updatedAt?.slice(0, 16).replace("T", " ") ?? t(locale, "settings.threads-unknown"),
  });
}

function messageSampledAt(ctx: Context): string {
  const seconds = ctx.message?.date;
  return new Date(seconds ? seconds * 1000 : Date.now()).toISOString();
}
