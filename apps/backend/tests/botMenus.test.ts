import { afterEach, describe, expect, it } from "bun:test";
import type { Menu } from "@grammyjs/menu";
import type { Context } from "grammy";
import { buildMainMenu } from "../src/bot/navigation.js";
import { buildNotificationsMenu } from "../src/bot/notifications-screen.js";
import { buildSettingsMenu } from "../src/bot/settings-screen.js";
import { isAdmin } from "../src/bot.js";
import type { BackendDb } from "../src/db/client.js";
import { openBackendDb } from "../src/db/client.js";
import { loadConfig } from "../src/foundation/config.js";

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

async function settingsMenuLabels(config: ReturnType<typeof loadConfig>, db: BackendDb): Promise<string[]> {
  return renderLabels(buildSettingsMenu(config, db));
}

describe("isAdmin", () => {
  it("rejects an undefined user id", () => {
    expect(isAdmin(loadConfig({ ADMIN_IDS: "1,2" }), undefined)).toBe(false);
  });

  it("accepts a user id listed in ADMIN_IDS", () => {
    expect(isAdmin(loadConfig({ ADMIN_IDS: "1,2" }), 2)).toBe(true);
  });

  it("rejects a user id not listed in ADMIN_IDS", () => {
    expect(isAdmin(loadConfig({ ADMIN_IDS: "1,2" }), 3)).toBe(false);
  });

  it("rejects everyone when ADMIN_IDS is empty", () => {
    expect(isAdmin(loadConfig({ ADMIN_IDS: "" }), 1)).toBe(false);
  });
});

describe("buildMainMenu", () => {
  it("shows post creation, no video creation, and analytics for a text+analytics studio", async () => {
    backendDb = openBackendDb(":memory:");
    const config = loadConfig({});
    config.studio.modules.text_posting = true;
    config.studio.modules.video_posting = false;
    config.studio.modules.analytics = true;

    const labels = await mainMenuLabels(config, backendDb);
    expect(labels.some((text) => /new post/i.test(text))).toBe(true);
    expect(labels.some((text) => /new video/i.test(text))).toBe(false);
    expect(labels.some((text) => /analytics/i.test(text))).toBe(true);
  });

  it("shows video creation, no post creation, for a video-only studio", async () => {
    backendDb = openBackendDb(":memory:");
    const config = loadConfig({});
    config.studio.modules.text_posting = false;
    config.studio.modules.video_posting = true;

    const labels = await mainMenuLabels(config, backendDb);
    expect(labels.some((text) => /new video/i.test(text))).toBe(true);
    expect(labels.some((text) => /new post/i.test(text))).toBe(false);
  });

  it("hides the analytics button when the module is disabled", async () => {
    backendDb = openBackendDb(":memory:");
    const config = loadConfig({});
    config.studio.modules.analytics = false;

    const labels = await mainMenuLabels(config, backendDb);
    expect(labels.some((text) => /analytics/i.test(text))).toBe(false);
  });
});

describe("buildSettingsMenu", () => {
  it("shows the YouTube signature entry when the module is enabled", async () => {
    backendDb = openBackendDb(":memory:");
    const config = loadConfig({});
    config.studio.modules.youtube = true;

    const labels = await settingsMenuLabels(config, backendDb);
    expect(labels.some((text) => /youtube/i.test(text))).toBe(true);
  });

  it("hides the YouTube signature entry when the module is disabled", async () => {
    backendDb = openBackendDb(":memory:");
    const config = loadConfig({});
    config.studio.modules.youtube = false;

    const labels = await settingsMenuLabels(config, backendDb);
    expect(labels.some((text) => /youtube/i.test(text))).toBe(false);
  });
});
