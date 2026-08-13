import { afterEach, describe, expect, it } from "bun:test";
import type { Menu } from "@grammyjs/menu";
import type { Context } from "grammy";
import { buildMainMenu } from "../src/bot/navigation.js";
import { buildNotificationsMenu } from "../src/bot/notifications-screen.js";
import { buildSettingsMenu } from "../src/bot/settings-screen.js";
import { isAdmin } from "../src/bot.js";
import { registerChannel } from "../src/channels/registry.js";
import type { BackendDb } from "../src/db/client.js";
import { loadConfig } from "../src/foundation/config.js";
import { openBackendDb } from "./helpers/open-db.js";

let backendDb: BackendDb | null = null;

afterEach(() => {
  backendDb?.close();
  backendDb = null;
});

const fakeCtx = { from: { id: 1 } } as unknown as Context;

/** `Menu.render` is typed `protected` (internal API), but it's the plugin's
 * own documented way to resolve a menu's button labels for a given ctx
 * without going through a real Telegram update. */
async function renderLabels(menu: Menu<Context>): Promise<string[]> {
  const rows: Array<Array<{ text: string }>> = await (
    menu as unknown as { render: (ctx: Context) => Promise<Array<Array<{ text: string }>>> }
  ).render(fakeCtx);
  return rows.flat().map((btn) => btn.text);
}

async function mainMenuLabels(config: ReturnType<typeof loadConfig>, db: BackendDb): Promise<string[]> {
  const notificationsMenu = buildNotificationsMenu(config, db);
  const settingsMenu = buildSettingsMenu(config, db);
  const mainMenu = buildMainMenu(config, db, settingsMenu, notificationsMenu);
  return renderLabels(mainMenu);
}

async function settingsMenuLabels(config: ReturnType<typeof loadConfig>, db: BackendDb, submenu?: string): Promise<string[]> {
  const settings = buildSettingsMenu(config, db);
  return renderLabels(submenu ? settings.at(submenu) : settings);
}

describe("isAdmin", () => {
  it("rejects an undefined user id", () => {
    expect(isAdmin(loadConfig({ CONTROLLER_ADMIN_IDS: "1,2" }), undefined)).toBe(false);
  });

  it("accepts a user id listed in CONTROLLER_ADMIN_IDS", () => {
    expect(isAdmin(loadConfig({ CONTROLLER_ADMIN_IDS: "1,2" }), 2)).toBe(true);
  });

  it("rejects a user id not listed in CONTROLLER_ADMIN_IDS", () => {
    expect(isAdmin(loadConfig({ CONTROLLER_ADMIN_IDS: "1,2" }), 3)).toBe(false);
  });

  it("rejects everyone when CONTROLLER_ADMIN_IDS is empty", () => {
    expect(isAdmin(loadConfig({ CONTROLLER_ADMIN_IDS: "" }), 1)).toBe(false);
  });
});

describe("buildMainMenu", () => {
  it("offers post creation, video creation and analytics", async () => {
    backendDb = openBackendDb(":memory:");
    const config = loadConfig({});
    const labels = await mainMenuLabels(config, backendDb);
    expect(labels.some((text) => /new post/i.test(text))).toBe(true);
    expect(labels.some((text) => /new video/i.test(text))).toBe(true);
    expect(labels.some((text) => /analytics/i.test(text))).toBe(true);
  });
});

describe("buildSettingsMenu", () => {
  it("groups every setting under a category instead of one flat list", async () => {
    backendDb = openBackendDb(":memory:");
    const config = loadConfig({});
    const labels = await settingsMenuLabels(config, backendDb);
    expect(labels).toEqual(["📡 Publishing", "🔔 Notifications", "📊 Analytics", "⚙️ General", "← Menu"]);
  });

  it("keeps the news digest under notifications", async () => {
    backendDb = openBackendDb(":memory:");
    const config = loadConfig({});

    const labels = await settingsMenuLabels(config, backendDb, "settings-notifications-category");
    expect(labels).toContain("📰 News digest");
  });

  it("renders the news digest controls with a back button", async () => {
    backendDb = openBackendDb(":memory:");
    const config = loadConfig({});

    const labels = await settingsMenuLabels(config, backendDb, "settings-news-digest");
    expect(labels).toEqual(["◻️ News digest", "🕒 Delivery time: 10:00", "✏️ Change prompt", "▶️ Send now", "← Notifications"]);
  });

  it("offers the manual analytics inputs no platform API provides", async () => {
    backendDb = openBackendDb(":memory:");
    const config = loadConfig({});
    const labels = await settingsMenuLabels(config, backendDb, "settings-analytics");
    expect(labels.some((text) => /threads followers/i.test(text))).toBe(true);
    expect(labels.some((text) => /import x csv/i.test(text))).toBe(true);
  });

  it("shows the YouTube signature entry when a YouTube channel is connected", async () => {
    backendDb = openBackendDb(":memory:");
    const config = loadConfig({});
    registerChannel(backendDb, { platform: "youtube", locale: "ru", provider: "native" });

    const labels = await settingsMenuLabels(config, backendDb, "settings-publishing");
    expect(labels.some((text) => /youtube/i.test(text))).toBe(true);
  });

  it("hides the YouTube signature entry when no YouTube channel is connected", async () => {
    backendDb = openBackendDb(":memory:");
    const config = loadConfig({});

    const labels = await settingsMenuLabels(config, backendDb, "settings-publishing");
    expect(labels.some((text) => /youtube/i.test(text))).toBe(false);
  });
});
