import { describe, expect, it } from "bun:test";
import { textLocale } from "../src/content/text-locale.js";

/** The whole value of this check is that it never refuses a post that was fine.
 * These are the shapes real posts take, and the ones that must stay unknown are
 * as much the contract as the ones that must be recognised. */
describe("text locale", () => {
  it("reads Russian through its anglicisms", () => {
    expect(textLocale("Сегодня разобрал, как мы используем React, TypeScript и Bun в проде — вышло короче, чем ожидал")).toBe("ru");
    expect(textLocale("Разбор кейса: как Threads API, Instagram Graph и YouTube Data API считают просмотры по-разному")).toBe("ru");
    expect(textLocale("Вышел новый пост про Threads: https://alexgetman.com/blog/threads-api #threads @alexgetman")).toBe("ru");
  });

  it("reads English prose", () => {
    expect(textLocale("Today I shipped the new analytics dashboard and it finally reads the way I wanted")).toBe("en");
    expect(textLocale("New analytics dashboard shipped today")).toBe("en");
  });

  it("refuses to guess where a post says nothing about its language", () => {
    // A list of the things a Russian post is about is not an English post, and
    // calling it one would refuse it on the channel it was written for.
    expect(textLocale("Astra: Bun, Drizzle, SQLite, Hono, Astro, Biome, Lefthook, GitHub Actions")).toBeNull();
    expect(textLocale("Astra, Bun, Threads API, YouTube Shorts, Instagram Reels — 2026")).toBeNull();
    // Too short to carry a signal at all.
    expect(textLocale("🔥🔥🔥")).toBeNull();
    expect(textLocale("https://alexgetman.com @alexgetman #release")).toBeNull();
    // An English post quoting a Russian name stays unknown rather than Russian.
    expect(textLocale("The channel «Алекс Гетман» is now live in English too, same posts, translated")).toBeNull();
  });
});
