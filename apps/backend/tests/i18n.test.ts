import { describe, expect, it } from "bun:test";
import { catalog, plural, resolveUiLocale, t } from "../src/interfaces/telegram/i18n/index.js";

describe("telegram i18n", () => {
  it("translates keys and interpolates params per locale", () => {
    expect(t("en", "menu.control-panel")).toBe("Control panel");
    expect(t("ru", "menu.control-panel")).toBe("Панель управления");
    expect(t("en", "menu.work-queue-count", { count: 3 })).toBe("📋 Work queue · 3");
    expect(t("ru", "menu.settings-unread", { count: 2 })).toBe("⚙️ Настройки · 🔴2");
  });

  it("keeps the two catalogs at parity", () => {
    expect(Object.keys(catalog.ru).sort()).toEqual(Object.keys(catalog.en).sort());
  });

  it("applies Russian CLDR plural rules", () => {
    const forms = { one: "{n} день", few: "{n} дня", many: "{n} дней" };
    expect(plural("ru", 1, forms)).toBe("1 день");
    expect(plural("ru", 2, forms)).toBe("2 дня");
    expect(plural("ru", 5, forms)).toBe("5 дней");
    expect(plural("ru", 11, forms)).toBe("11 дней");
    expect(plural("ru", 21, forms)).toBe("21 день");
    expect(plural("en", 1, { one: "{n} day", many: "{n} days" })).toBe("1 day");
    expect(plural("en", 4, { one: "{n} day", many: "{n} days" })).toBe("4 days");
  });

  it("resolves locale: stored wins, then Telegram language, then English", () => {
    expect(resolveUiLocale("ru", "en-US")).toBe("ru");
    expect(resolveUiLocale(null, "ru-RU")).toBe("ru");
    expect(resolveUiLocale(null, "de-DE")).toBe("en");
    expect(resolveUiLocale(undefined, undefined)).toBe("en");
  });
});
