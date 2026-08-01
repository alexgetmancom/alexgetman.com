import { Menu, type MenuFlavor } from "@grammyjs/menu";
import type { Context } from "grammy";
import { credentialShape, setChannelSecrets } from "../channels/credentials.js";
import { isPublishableVideoPlatform, VIDEO_PLATFORM_TARGET } from "../channels/destinations.js";
import { listChannels, registerChannel } from "../channels/registry.js";
import type { BackendDb } from "../db/client.js";
import type { BackendConfig } from "../foundation/config.js";
import { requestJson } from "../foundation/http.js";
import { t } from "../foundation/i18n/index.js";
import { escapeMarkdown } from "../foundation/markdown.js";
import { studioServices } from "../studio/services/index.js";
import { botLocale } from "./i18n.js";
import { persistentKeyboard } from "./menu-render.js";
import { NOTIFICATIONS_MENU_ID, notificationsInboxText } from "./notifications-screen.js";

export const SETTINGS_MENU_ID = "settings-menu";
const NOTIFICATION_SETTINGS_MENU_ID = "settings-notifications";
const WEEKLY_DIGEST_MENU_ID = "settings-weekly-digest";
const YOUTUBE_SIGNATURE_MENU_ID = "settings-youtube";
const LANGUAGE_MENU_ID = "settings-language";
const CHANNELS_MENU_ID = "settings-channels";

/** Platforms whose accounts carry their own credentials, so they can be
 * connected here instead of through a deployment variable. */
const NATIVE_CONNECTABLE_PLATFORMS = Object.keys(VIDEO_PLATFORM_TARGET).filter(isPublishableVideoPlatform);

type ZernioAccount = { _id?: string; username?: string; displayName?: string; platform?: string };
type ZernioAccounts = { accounts?: ZernioAccount[] } | ZernioAccount[];
const discoveredAccounts = new Map<number, { locale: "ru" | "en"; accounts: ZernioAccount[]; hidden: number }>();

/**
 * A native connection being assembled, one value per message.
 *
 * Native accounts each carry their own secret, unlike Zernio accounts which
 * share one deployment-wide key and differ only by id. Collecting them here is
 * what makes "connect a channel" an action in an interface rather than a
 * redeploy — the values land in the encrypted per-channel store.
 */
type PendingConnection = { platform: string; locale: "ru" | "en"; remaining: string[]; collected: Record<string, string> };
const pendingConnections = new Map<number, PendingConnection>();

/** Settings is an interface screen: it owns its callbacks and the small
 * transient input state, keeping the root Telegram router transport-only. */
export async function handleSettingsMessage(
  ctx: Context,
  backendDb: BackendDb,
  config: BackendConfig,
  settingsMenu: Menu<Context>,
): Promise<boolean> {
  const actorId = Number(ctx.from?.id);
  const text = ctx.message && "text" in ctx.message ? (ctx.message.text?.trim() ?? "") : "";
  if (await collectChannelCredential(ctx, backendDb, config, actorId, text)) return true;
  if (!studioServices(backendDb, config).settings.saveYoutubeSignature(actorId, text)) return false;
  const locale = botLocale(backendDb, actorId);
  await ctx.reply(t(locale, "settings.youtube-saved"));
  await ctx.reply(youtubeSignatureText(backendDb, config, actorId, locale), {
    parse_mode: "Markdown",
    reply_markup: settingsMenu.at(YOUTUBE_SIGNATURE_MENU_ID),
  });
  return true;
}

export function buildSettingsMenu(config: BackendConfig, backendDb: BackendDb): Menu<Context> {
  const channels = new Menu<Context>(CHANNELS_MENU_ID, { autoAnswer: false }).dynamic((ctx, range) => {
    const actorId = Number(ctx.from?.id);
    const locale = botLocale(backendDb, actorId);
    const discovered = discoveredAccounts.get(actorId);
    if (discovered) {
      for (const account of discovered.accounts) {
        if (!account._id) continue;
        const platform = zernioPlatform(account);
        // A channel the pipeline has no target for would sit in the registry
        // and never publish, so it is never offered.
        if (!isPublishableVideoPlatform(platform)) continue;
        range
          .text(
            `${channelPlatformLabel(platform)} ${discovered.locale.toUpperCase()} · @${account.username ?? account.displayName ?? account._id}`,
            async (ctx) => {
              registerChannel(backendDb, {
                platform,
                locale: discovered.locale,
                provider: "zernio",
                ...(account._id ? { providerAccountId: account._id } : {}),
                label: `${channelPlatformLabel(platform)} ${discovered.locale.toUpperCase()} · @${account.username ?? account.displayName ?? account._id}`,
                source: "telegram",
              });
              discoveredAccounts.delete(actorId);
              await ctx.answerCallbackQuery({ text: t(locale, "settings.channel-connected") });
              await ctx.editMessageText(channelsText(backendDb, locale));
            },
          )
          .row();
      }
    }
    if (config.ZERNIO_API_KEY)
      range
        .text("➕ Zernio · RU", (ctx) => discoverZernio(ctx, actorId, "ru", locale))
        .text("➕ Zernio · EN", (ctx) => discoverZernio(ctx, actorId, "en", locale))
        .row();
    // Native accounts are offered for every platform the pipeline publishes to,
    // regardless of what the deployment's variables happen to hold.
    for (const platform of NATIVE_CONNECTABLE_PLATFORMS) {
      range
        .text(`➕ ${channelPlatformLabel(platform)} · RU`, (ctx) => startNativeConnection(ctx, actorId, platform, "ru", locale))
        .text(`➕ ${channelPlatformLabel(platform)} · EN`, (ctx) => startNativeConnection(ctx, actorId, platform, "en", locale))
        .row();
    }
    range.back(t(locale, "settings.back-to-settings"), async (ctx) => {
      discoveredAccounts.delete(actorId);
      await ctx.answerCallbackQuery();
      await ctx.editMessageText(t(locale, "settings.title"));
    });
  });

  const notificationSettings = new Menu<Context>(NOTIFICATION_SETTINGS_MENU_ID, { autoAnswer: false }).dynamic((ctx, range) => {
    const actorId = Number(ctx.from?.id);
    const settings = studioServices(backendDb, config).settings.notifications(actorId);
    const locale = botLocale(backendDb, actorId);
    range
      .text(`${settings.remindersEnabled ? "✅" : "◻️"} ${t(locale, "settings.reminder-label")}`, async (ctx) => {
        studioServices(backendDb, config).settings.setNotifications(actorId, { remindersEnabled: !settings.remindersEnabled });
        await ctx.answerCallbackQuery();
        await ctx.editMessageText(notificationSettingsText(backendDb, config, actorId, locale), { parse_mode: "Markdown" });
      })
      .text(`${settings.completionEnabled ? "✅" : "◻️"} ${t(locale, "settings.completion-label")}`, async (ctx) => {
        studioServices(backendDb, config).settings.setNotifications(actorId, { completionEnabled: !settings.completionEnabled });
        await ctx.answerCallbackQuery();
        await ctx.editMessageText(notificationSettingsText(backendDb, config, actorId, locale), { parse_mode: "Markdown" });
      })
      .row();
    for (const minutes of [1, 5, 10, 15, 30] as const) {
      range.text(String(minutes), async (ctx) => {
        studioServices(backendDb, config).settings.setNotifications(actorId, { reminderMinutes: minutes });
        await ctx.answerCallbackQuery({ text: t(locale, "settings.minutes-toast", { minutes }) });
        await ctx.editMessageText(notificationSettingsText(backendDb, config, actorId, locale), { parse_mode: "Markdown" });
      });
    }
    range.row().back(t(locale, "settings.back-to-settings"), async (ctx) => {
      await ctx.answerCallbackQuery();
      await ctx.editMessageText(t(locale, "settings.title"));
    });
  });

  const weeklyDigest = new Menu<Context>(WEEKLY_DIGEST_MENU_ID, { autoAnswer: false }).dynamic((ctx, range) => {
    const actorId = Number(ctx.from?.id);
    const settings = studioServices(backendDb, config).settings.weeklyDigest();
    const locale = botLocale(backendDb, actorId);
    range
      .text(`${settings.enabled ? "✅" : "◻️"} ${t(locale, "settings.weekly-digest-enabled")}`, async (ctx) => {
        studioServices(backendDb, config).settings.setWeeklyDigest({ enabled: !settings.enabled });
        await ctx.answerCallbackQuery();
        await ctx.editMessageText(weeklyDigestText(backendDb, config, locale), { parse_mode: "Markdown" });
      })
      .row();
    for (const weekday of [1, 2, 3, 4, 5, 6, 0] as const) {
      range.text(`${settings.weekday === weekday ? "● " : ""}${weekdayLabel(locale, weekday)}`, async (ctx) => {
        studioServices(backendDb, config).settings.setWeeklyDigest({ weekday });
        await ctx.answerCallbackQuery({ text: t(locale, "settings.weekly-digest-day-set", { day: weekdayLabel(locale, weekday) }) });
        await ctx.editMessageText(weeklyDigestText(backendDb, config, locale), { parse_mode: "Markdown" });
      });
      if (weekday === 4) range.row();
    }
    range.row().back(t(locale, "settings.back-to-settings"), async (ctx) => {
      await ctx.answerCallbackQuery();
      await ctx.editMessageText(t(locale, "settings.title"));
    });
  });

  const youtubeSignature = new Menu<Context>(YOUTUBE_SIGNATURE_MENU_ID, { autoAnswer: false }).dynamic((ctx, range) => {
    const actorId = Number(ctx.from?.id);
    const locale = botLocale(backendDb, actorId);
    range
      .text(t(locale, "settings.edit"), async (ctx) => {
        studioServices(backendDb, config).settings.beginYoutubeSignatureEdit(actorId);
        await ctx.answerCallbackQuery();
        await ctx.reply(t(locale, "settings.youtube-edit-prompt"));
      })
      .text(t(locale, "settings.clear"), async (ctx) => {
        studioServices(backendDb, config).settings.clearYoutubeSignature(actorId);
        await ctx.answerCallbackQuery({ text: t(locale, "settings.cleared") });
        await ctx.editMessageText(youtubeSignatureText(backendDb, config, actorId, locale), { parse_mode: "Markdown" });
      })
      .row()
      .back(t(locale, "settings.back-to-settings"), async (ctx) => {
        await ctx.answerCallbackQuery();
        await ctx.editMessageText(t(locale, "settings.title"));
      });
  });

  const language = new Menu<Context>(LANGUAGE_MENU_ID, { autoAnswer: false }).dynamic((ctx, range) => {
    const locale = botLocale(backendDb, Number(ctx.from?.id));
    range
      .text("English", (ctx) => switchLanguage(ctx, "en"))
      .text("Русский", (ctx) => switchLanguage(ctx, "ru"))
      .row()
      .back(t(locale, "common.back"), async (ctx) => {
        await ctx.answerCallbackQuery();
        await ctx.editMessageText(t(locale, "settings.title"));
      });
  });

  const settings = new Menu<Context>(SETTINGS_MENU_ID, { autoAnswer: false });
  settings.dynamic((ctx, range) => {
    const actorId = Number(ctx.from?.id);
    const locale = botLocale(backendDb, actorId);
    if (config.studio.modules.youtube)
      range
        .submenu(t(locale, "settings.youtube-signature"), YOUTUBE_SIGNATURE_MENU_ID, async (ctx) => {
          await ctx.answerCallbackQuery();
          await ctx.editMessageText(youtubeSignatureText(backendDb, config, actorId, locale), { parse_mode: "Markdown" });
        })
        .row();
    range
      .submenu(t(locale, "settings.channels"), CHANNELS_MENU_ID, async (ctx) => {
        await ctx.answerCallbackQuery();
        await ctx.editMessageText(channelsText(backendDb, locale));
      })
      .row()
      .submenu(t(locale, "settings.notifications"), NOTIFICATIONS_MENU_ID, async (ctx) => {
        await ctx.answerCallbackQuery();
        await ctx.editMessageText(notificationsInboxText(backendDb, config, actorId, locale));
      })
      .row()
      .submenu(t(locale, "settings.publication-notifications"), NOTIFICATION_SETTINGS_MENU_ID, async (ctx) => {
        await ctx.answerCallbackQuery();
        await ctx.editMessageText(notificationSettingsText(backendDb, config, actorId, locale), { parse_mode: "Markdown" });
      })
      .row()
      .submenu(t(locale, "settings.weekly-digest"), WEEKLY_DIGEST_MENU_ID, async (ctx) => {
        await ctx.answerCallbackQuery();
        await ctx.editMessageText(weeklyDigestText(backendDb, config, locale), { parse_mode: "Markdown" });
      })
      .row()
      .submenu(t(locale, "settings.language"), LANGUAGE_MENU_ID, async (ctx) => {
        await ctx.answerCallbackQuery();
        await ctx.editMessageText(t(locale, "settings.language-title"));
      })
      .row()
      .back(t(locale, "common.menu"), async (ctx) => {
        await ctx.answerCallbackQuery();
        await ctx.editMessageText(t(locale, "menu.control-panel"));
      });
  });
  settings.register(notificationSettings);
  settings.register(weeklyDigest);
  settings.register(youtubeSignature);
  settings.register(language);
  settings.register(channels);
  return settings;

  async function startNativeConnection(
    ctx: Context & MenuFlavor,
    actorId: number,
    platform: string,
    channelLocale: "ru" | "en",
    locale: ReturnType<typeof botLocale>,
  ): Promise<void> {
    if (!config.CHANNEL_SECRET_KEY) {
      await ctx.answerCallbackQuery({ text: t(locale, "settings.channel-no-secret-key"), show_alert: true });
      return;
    }
    const shape = credentialShape(platform, "native", channelLocale);
    if (!shape.length) {
      await ctx.answerCallbackQuery({ text: t(locale, "settings.channels-error"), show_alert: true });
      return;
    }
    pendingConnections.set(actorId, {
      platform,
      locale: channelLocale,
      remaining: shape.map((field) => field.name),
      collected: {},
    });
    await ctx.answerCallbackQuery();
    await askNextCredential(ctx, actorId, locale);
  }

  async function discoverZernio(
    ctx: Context & MenuFlavor,
    actorId: number,
    channelLocale: "ru" | "en",
    locale: ReturnType<typeof botLocale>,
  ) {
    try {
      const headers = { Authorization: `Bearer ${config.ZERNIO_API_KEY}` };
      const response = await requestJson<ZernioAccounts>(fetch, "https://zernio.com/api/v1/accounts", { headers });
      const accounts = Array.isArray(response) ? response : (response.accounts ?? []);
      const supported = accounts.filter((account) => isPublishableVideoPlatform(zernioPlatform(account)));
      discoveredAccounts.set(actorId, { locale: channelLocale, accounts, hidden: accounts.length - supported.length });
      await ctx.answerCallbackQuery({ text: t(locale, "settings.channels-found", { count: supported.length }) });
      await ctx.editMessageText(channelsText(backendDb, locale, supported.length, accounts.length - supported.length));
      await ctx.menu.update();
    } catch {
      await ctx.answerCallbackQuery({ text: t(locale, "settings.channels-error"), show_alert: true });
    }
  }

  async function switchLanguage(ctx: Context & MenuFlavor, locale: "en" | "ru"): Promise<void> {
    const actorId = Number(ctx.from?.id);
    studioServices(backendDb, config).settings.setLocale(actorId, locale);
    await ctx.answerCallbackQuery({ text: t(locale, "settings.language-set") });
    ctx.menu.nav(SETTINGS_MENU_ID);
    await ctx.editMessageText(t(locale, "settings.title"));
    await ctx.reply(t(locale, "settings.keyboard-updated"), { reply_markup: persistentKeyboard(locale) });
  }
}

function weekdayLabel(locale: ReturnType<typeof botLocale>, weekday: number): string {
  const labels = locale === "ru" ? ["Вс", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"] : ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return labels[weekday] ?? labels[0] ?? "";
}

function weeklyDigestText(backendDb: BackendDb, config: BackendConfig, locale: ReturnType<typeof botLocale>): string {
  const settings = studioServices(backendDb, config).settings.weeklyDigest();
  return t(locale, "settings.weekly-digest-body", {
    status: settings.enabled ? t(locale, "settings.on") : t(locale, "settings.off"),
    day: weekdayLabel(locale, settings.weekday),
  });
}

async function askNextCredential(ctx: Context, actorId: number, locale: ReturnType<typeof botLocale>): Promise<void> {
  const pending = pendingConnections.get(actorId);
  const field = pending?.remaining[0];
  if (!pending || !field) return;
  await ctx.reply(
    t(locale, "settings.channel-ask", {
      field,
      channel: `${channelPlatformLabel(pending.platform)} ${pending.locale.toUpperCase()}`,
    }),
    { parse_mode: "Markdown" },
  );
}

/**
 * Consumes one credential value from a message, or reports that this message is
 * not part of a connection.
 *
 * The message is deleted right after the value is stored: a publishing token
 * left in the chat history is readable by anyone who later gets to the account,
 * and unlike the encrypted store, Telegram is not where it belongs.
 */
async function collectChannelCredential(
  ctx: Context,
  backendDb: BackendDb,
  config: BackendConfig,
  actorId: number,
  text: string,
): Promise<boolean> {
  const pending = pendingConnections.get(actorId);
  if (!pending) return false;
  const locale = botLocale(backendDb, actorId);
  if (!text) return true;
  if (text === "/cancel") {
    pendingConnections.delete(actorId);
    await ctx.reply(t(locale, "settings.channel-cancel"));
    return true;
  }
  const field = pending.remaining.shift();
  if (!field) return true;
  pending.collected[field] = text;
  try {
    await ctx.api.deleteMessage(ctx.chat?.id ?? actorId, ctx.message?.message_id ?? 0);
  } catch {
    // Telegram refuses deletions older than 48 hours and in some chat types.
    // The value is already stored; failing to tidy up is not worth an error.
  }
  if (pending.remaining.length) {
    await ctx.reply(t(locale, "settings.channel-stored", { remaining: pending.remaining.length }));
    await askNextCredential(ctx, actorId, locale);
    return true;
  }
  pendingConnections.delete(actorId);
  const label = `${channelPlatformLabel(pending.platform)} ${pending.locale.toUpperCase()}`;
  const channel = registerChannel(backendDb, {
    platform: pending.platform,
    locale: pending.locale,
    provider: "native",
    label,
    source: "telegram",
    ...(pending.collected.userId ? { providerAccountId: pending.collected.userId } : {}),
  });
  setChannelSecrets(backendDb, config.CHANNEL_SECRET_KEY, channel.id, pending.collected);
  await ctx.reply(t(locale, "settings.channel-ready", { channel: label }));
  return true;
}

function zernioPlatform(account: ZernioAccount): string {
  const value = account.platform?.trim().toLowerCase();
  if (value?.includes("tiktok")) return "tiktok";
  if (value?.includes("youtube")) return "youtube";
  return "instagram";
}

function channelPlatformLabel(platform: string): string {
  return platform === "tiktok" ? "TikTok" : platform === "youtube" ? "YouTube" : "Instagram";
}

function channelsText(backendDb: BackendDb, locale: ReturnType<typeof botLocale>, discoveredCount?: number, hiddenCount = 0): string {
  const rows = listChannels(backendDb).map(
    (channel) => `• ${channel.label} — ${channel.provider}${channel.providerAccountId ? ` · ${channel.providerAccountId}` : ""}`,
  );
  const suffix = discoveredCount == null ? "" : `\n\n${t(locale, "settings.channels-pick", { count: discoveredCount })}`;
  const hidden = hiddenCount ? `\n${t(locale, "settings.channels-unsupported", { count: hiddenCount })}` : "";
  return `${t(locale, "settings.channels-title")}\n\n${rows.join("\n") || t(locale, "settings.channels-none")}${suffix}${hidden}`;
}

export async function showSettings(ctx: Context, backendDb: BackendDb, settingsMenu: Menu<Context>, edit = false): Promise<void> {
  const locale = botLocale(backendDb, Number(ctx.from?.id));
  const text = t(locale, "settings.title");
  const options = { reply_markup: settingsMenu };
  if (edit) await ctx.editMessageText(text, options);
  else await ctx.reply(text, options);
}

function notificationSettingsText(
  backendDb: BackendDb,
  config: BackendConfig,
  actorId: number,
  locale: ReturnType<typeof botLocale>,
): string {
  const settings = studioServices(backendDb, config).settings.notifications(actorId);
  const on = (value: boolean) => (value ? t(locale, "settings.on") : t(locale, "settings.off"));
  return t(locale, "settings.notif-body", {
    reminders: on(settings.remindersEnabled),
    minutes: settings.reminderMinutes,
    completion: on(settings.completionEnabled),
  });
}

function youtubeSignatureText(backendDb: BackendDb, config: BackendConfig, actorId: number, locale: ReturnType<typeof botLocale>): string {
  const signature = studioServices(backendDb, config).settings.youtubeSignature(actorId);
  return t(locale, "settings.youtube-body", {
    signature: signature ? escapeMarkdown(signature) : t(locale, "settings.youtube-not-set"),
  });
}
