import { beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { hasMutedPreference, readMutedPreference, writeMutedPreference } from "./preferences.js";

/**
 * The distinction these tests pin down is the whole reason hasMutedPreference
 * exists: "muted" and "never asked" both read as muted, but only the second
 * should make the player prompt for sound. Getting it wrong either nags a
 * visitor who already said no, or never offers sound at all — and the second
 * is what the player did before, since muted is the default.
 */

const MUTED_KEY = "story-player-muted";

beforeEach(() => {
  const window = new Window();
  globalThis.localStorage = window.localStorage as unknown as Storage;
  localStorage.clear();
});

describe("mute preference", () => {
  test("a fresh visitor is muted but has expressed no preference", () => {
    expect(readMutedPreference()).toBe(true);
    expect(hasMutedPreference()).toBe(false);
  });

  test("choosing sound is remembered and counts as an answer", () => {
    writeMutedPreference(false);
    expect(readMutedPreference()).toBe(false);
    expect(hasMutedPreference()).toBe(true);
  });

  test("choosing silence is an answer too, so the prompt stays away", () => {
    writeMutedPreference(true);
    expect(readMutedPreference()).toBe(true);
    // Same value a fresh visitor reads — only hasMutedPreference separates them.
    expect(hasMutedPreference()).toBe(true);
  });

  test("a junk value is not an answer", () => {
    localStorage.setItem(MUTED_KEY, "yes");
    expect(hasMutedPreference()).toBe(false);
  });
});
