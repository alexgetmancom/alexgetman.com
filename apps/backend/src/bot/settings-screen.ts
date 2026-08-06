import { Menu, type MenuFlavor } from "@grammyjs/menu";
import type { Context } from "grammy";
import type { BackendDb } from "../db/client.js";
import type { BackendConfig } from "../foundation/config.js";
import { t } from "../foundation/i18n/index.js";
import { escapeMarkdown } from "../foundation/markdown.js";
import type { StudioZernioAccount } from "../studio/services/channels.js";
import { createStudioServices } from "../studio/services/index.js";
import { botLocale } from "./i18n.js";
import { persistentKeyboard } from "./menu-render.js";
import { NOTIFICATIONS_MENU_ID, notificationsInboxText } from "./notifications-screen.js";

export const SETTINGS_MENU_ID = "settings-menu";
const NOTIFICATION_SETTINGS_MENU_ID = "settings-notifications";
const WEEKLY_DIGEST_MENU_ID = "settings-weekly-digest";
const YOUTUBE_SIGNATURE_MENU_ID = "settings-youtube";
const LANGUAGE_MENU_ID = "settings-language";
const CHANNELS_MENU_ID = "settings-channels";
const TIMEZONE_MENU_ID = "settings-timezone";
type ZernioAccount = StudioZernioAccount;
const discoveredAccounts = new Map<number, { locale: "ru" | "en"; accounts: ZernioAccount[] }>();
const pendingTimezones = new Set<number>();

const TIMEZONE_OPTIONS = [
  ["UTC", "UTC"],
  ["Europe/London", "Europe/London"],
  ["Europe/Berlin", "Europe/Berlin"],
  ["Europe/Moscow", "Europe/Moscow"],
  ["Asia/Dubai", "Asia/Dubai"],
  ["Asia/Tashkent", "Asia/Tashkent"],
  ["Asia/Kolkata", "Asia/Kolkata"],
  ["Asia/Bangkok", "Asia/Bangkok"],
  ["Asia/Singapore", "Asia/Singapore"],
  ["Asia/Tokyo", "Asia/Tokyo"],
  ["Australia/Sydney", "Australia/Sydney"],
  ["America/New_York", "America/New_York"],
  ["America/Chicago", "America/Chicago"],
  ["America/Denver", "America/Denver"],
  ["America/Los_Angeles", "America/Los_Angeles"],
] as const;

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
  if (await collectTimezone(ctx, backendDb, config, actorId, text, settingsMenu)) return true;
  if (await collectChannelCredential(ctx, backendDb, config, actorId, text)) return true;
  if (!createStudioServices(backendDb, config).settings.saveYoutubeSignature(actorId, text)) return false;
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
    const studioChannels = createStudioServices(backendDb, config).channels;
    const discovered = discoveredAccounts.get(actorId);
    if (discovered) {
      for (const account of discovered.accounts) {
        if (!account._id) continue;
        const platform = zernioPlatform(account);
        // A channel the pipeline has no target for would sit in the registry
        // and never publish, so it is never offered.
        if (!studioChannels.isPublishablePlatform(platform)) continue;
        range
          .text(
            `${channelPlatformLabel(platform)} ${discovered.locale.toUpperCase()} · @${account.username ?? account.displayName ?? account._id}`,
            async (ctx) => {
              studioChannels.connect({
                platform,
                locale: discovered.locale,
                provider: "zernio",
                ...(account._id ? { accountId: account._id } : {}),
                label: `${channelPlatformLabel(platform)} ${discovered.locale.toUpperCase()} · @${account.username ?? account.displayName ?? account._id}`,
              });
              discoveredAccounts.delete(actorId);
              await ctx.answerCallbackQuery({ text: t(locale, "settings.channel-connected") });
              await ctx.editMessageText(channelsText(backendDb, config, locale));
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
    for (const platform of studioChannels.nativeConnectablePlatforms()) {
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
    const settings = createStudioServices(backendDb, config).settings.notifications(actorId);
    const locale = botLocale(backendDb, actorId);
    range
      .text(`${settings.remindersEnabled ? "✅" : "◻️"} ${t(locale, "settings.reminder-label")}`, async (ctx) => {
        createStudioServices(backendDb, config).settings.setNotifications(actorId, { remindersEnabled: !settings.remindersEnabled });
        await ctx.answerCallbackQuery();
        await ctx.editMessageText(notificationSettingsText(backendDb, config, actorId, locale), { parse_mode: "Markdown" });
      })
      .text(`${settings.completionEnabled ? "✅" : "◻️"} ${t(locale, "settings.completion-label")}`, async (ctx) => {
        createStudioServices(backendDb, config).settings.setNotifications(actorId, { completionEnabled: !settings.completionEnabled });
        await ctx.answerCallbackQuery();
        await ctx.editMessageText(notificationSettingsText(backendDb, config, actorId, locale), { parse_mode: "Markdown" });
      })
      .row();
    for (const minutes of [1, 5, 10, 15, 30] as const) {
      range.text(String(minutes), async (ctx) => {
        createStudioServices(backendDb, config).settings.setNotifications(actorId, { reminderMinutes: minutes });
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
    const settings = createStudioServices(backendDb, config).settings.weeklyDigest();
    const locale = botLocale(backendDb, actorId);
    range
      .text(`${settings.enabled ? "✅" : "◻️"} ${t(locale, "settings.weekly-digest-enabled")}`, async (ctx) => {
        createStudioServices(backendDb, config).settings.setWeeklyDigest({ enabled: !settings.enabled });
        await ctx.answerCallbackQuery();
        await ctx.editMessageText(weeklyDigestText(backendDb, config, locale), { parse_mode: "Markdown" });
      })
      .row();
    for (const weekday of [1, 2, 3, 4, 5, 6, 0] as const) {
      range.text(`${settings.weekday === weekday ? "● " : ""}${weekdayLabel(locale, weekday)}`, async (ctx) => {
        createStudioServices(backendDb, config).settings.setWeeklyDigest({ weekday });
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
        createStudioServices(backendDb, config).settings.beginYoutubeSignatureEdit(actorId);
        await ctx.answerCallbackQuery();
        await ctx.reply(t(locale, "settings.youtube-edit-prompt"));
      })
      .text(t(locale, "settings.clear"), async (ctx) => {
        createStudioServices(backendDb, config).settings.clearYoutubeSignature(actorId);
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

  const timezone = new Menu<Context>(TIMEZONE_MENU_ID, { autoAnswer: false }).dynamic((ctx, range) => {
    const actorId = Number(ctx.from?.id);
    const locale = botLocale(backendDb, actorId);
    const service = createStudioServices(backendDb, config).settings;
    const current = service.timezone(actorId, config.TIMEZONE);
    const options = TIMEZONE_OPTIONS.some(([zone]) => zone === current) ? TIMEZONE_OPTIONS : [[current, current], ...TIMEZONE_OPTIONS];
    for (let index = 0; index < options.length; index += 2) {
      for (const [zone, label] of options.slice(index, index + 2))
        range.text(`${zone === current ? "●" : "○"} ${label}`, async (ctx) => {
          service.setTimezone(actorId, zone);
          await ctx.answerCallbackQuery({ text: t(locale, "settings.timezone-set", { timezone: zone }) });
          await ctx.editMessageText(timezoneText(backendDb, config, actorId, locale), { parse_mode: "Markdown" });
        });
      if (index + 2 < options.length) range.row();
    }
    range.row().text(t(locale, "settings.timezone-custom"), async (ctx) => {
      pendingTimezones.add(actorId);
      await ctx.answerCallbackQuery();
      await ctx.reply(t(locale, "settings.timezone-input-prompt"));
    });
    range.row().back(t(locale, "settings.back-to-settings"), async (ctx) => {
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
        await ctx.editMessageText(channelsText(backendDb, config, locale));
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
      .submenu(t(locale, "settings.timezone"), TIMEZONE_MENU_ID, async (ctx) => {
        await ctx.answerCallbackQuery();
        await ctx.editMessageText(timezoneText(backendDb, config, actorId, locale), { parse_mode: "Markdown" });
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
  settings.register(timezone);
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
    const shape = createStudioServices(backendDb, config).channels.credentialShape(platform, "native", channelLocale);
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
      const studioChannels = createStudioServices(backendDb, config).channels;
      const accounts = await studioChannels.discoverZernioAccounts();
      const supported = accounts.filter((account) => studioChannels.isPublishablePlatform(zernioPlatform(account)));
      discoveredAccounts.set(actorId, { locale: channelLocale, accounts });
      await ctx.answerCallbackQuery({ text: t(locale, "settings.channels-found", { count: supported.length }) });
      await ctx.editMessageText(channelsText(backendDb, config, locale, supported.length, accounts.length - supported.length));
      await ctx.menu.update();
    } catch {
      await ctx.answerCallbackQuery({ text: t(locale, "settings.channels-error"), show_alert: true });
    }
  }

  async function switchLanguage(ctx: Context & MenuFlavor, locale: "en" | "ru"): Promise<void> {
    const actorId = Number(ctx.from?.id);
    createStudioServices(backendDb, config).settings.setLocale(actorId, locale);
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
  const settings = createStudioServices(backendDb, config).settings.weeklyDigest();
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
 * A message that is navigation rather than input.
 *
 * Both collectors below sit in front of the router and claim the next message.
 * Without this, pressing the persistent keyboard button or sending a command
 * while a prompt is open stores that text as a time zone or a publishing token
 * and deletes the message, leaving the user with no way out but `/cancel`.
 */
function isNavigationMessage(text: string): boolean {
  return text.startsWith("/") || text === t("en", "menu.button") || text === t("ru", "menu.button");
}

async function collectTimezone(
  ctx: Context,
  backendDb: BackendDb,
  config: BackendConfig,
  actorId: number,
  text: string,
  settingsMenu: Menu<Context>,
): Promise<boolean> {
  if (!pendingTimezones.has(actorId)) return false;
  pendingTimezones.delete(actorId);
  if (isNavigationMessage(text)) return false;
  const locale = botLocale(backendDb, actorId);
  try {
    createStudioServices(backendDb, config).settings.setTimezone(actorId, text);
    await ctx.reply(t(locale, "settings.timezone-set", { timezone: text }));
    await ctx.reply(timezoneText(backendDb, config, actorId, locale), {
      parse_mode: "Markdown",
      reply_markup: settingsMenu.at(TIMEZONE_MENU_ID),
    });
  } catch {
    await ctx.reply(t(locale, "err.timezone-invalid"));
  }
  return true;
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
  if (text === "/cancel") {
    pendingConnections.delete(actorId);
    await ctx.reply(t(locale, "settings.channel-cancel"));
    return true;
  }
  if (isNavigationMessage(text)) {
    pendingConnections.delete(actorId);
    return false;
  }
  if (!text) {
    await askNextCredential(ctx, actorId, locale);
    return true;
  }
  const field = pending.remaining.shift();
  if (!field) return true;
  pending.collected[field] = text;
  const messageId = ctx.message?.message_id;
  if (messageId)
    try {
      await ctx.api.deleteMessage(ctx.chat?.id ?? actorId, messageId);
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
  const channel = createStudioServices(backendDb, config).channels.connect({
    platform: pending.platform,
    locale: pending.locale,
    provider: "native",
    label,
    ...(pending.collected.userId ? { accountId: pending.collected.userId } : {}),
    credentials: pending.collected,
  });
  await ctx.reply(t(locale, "settings.channel-ready", { channel: channel.channel.label }));
  return true;
}

function zernioPlatform(account: ZernioAccount): string {
  const value = account.platform?.trim().toLowerCase() ?? "";
  if (value.includes("tiktok")) return "tiktok";
  if (value.includes("youtube")) return "youtube";
  if (value.includes("instagram")) return "instagram";
  // Anything else is passed through unchanged so the publishable-platform
  // filter drops it, instead of a new platform silently posing as Instagram.
  return value;
}

function channelPlatformLabel(platform: string): string {
  return platform === "tiktok" ? "TikTok" : platform === "youtube" ? "YouTube" : "Instagram";
}

function channelsText(
  backendDb: BackendDb,
  config: BackendConfig,
  locale: ReturnType<typeof botLocale>,
  discoveredCount?: number,
  hiddenCount = 0,
): string {
  const rows = createStudioServices(backendDb, config)
    .channels.list()
    .map((channel) => `• ${channel.label} — ${channel.provider}${channel.providerAccountId ? ` · ${channel.providerAccountId}` : ""}`);
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
  const settings = createStudioServices(backendDb, config).settings.notifications(actorId);
  const on = (value: boolean) => (value ? t(locale, "settings.on") : t(locale, "settings.off"));
  return t(locale, "settings.notif-body", {
    reminders: on(settings.remindersEnabled),
    minutes: settings.reminderMinutes,
    completion: on(settings.completionEnabled),
  });
}

function timezoneText(backendDb: BackendDb, config: BackendConfig, actorId: number, locale: ReturnType<typeof botLocale>): string {
  const current = createStudioServices(backendDb, config).settings.timezone(actorId, config.TIMEZONE);
  return t(locale, "settings.timezone-body", { timezone: current });
}

function youtubeSignatureText(backendDb: BackendDb, config: BackendConfig, actorId: number, locale: ReturnType<typeof botLocale>): string {
  const signature = createStudioServices(backendDb, config).settings.youtubeSignature(actorId);
  return t(locale, "settings.youtube-body", {
    signature: signature ? escapeMarkdown(signature) : t(locale, "settings.youtube-not-set"),
  });
}
