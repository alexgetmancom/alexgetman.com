import { afterEach, describe, expect, it } from "bun:test";
import type { BackendDb } from "../src/db/client.js";
import { openBackendDb } from "../src/db/client.js";
import { postService } from "../src/studio/services/posts.js";

let backendDb: BackendDb | null = null;

afterEach(() => {
  backendDb?.close();
  backendDb = null;
});

describe("Studio post commands", () => {
  it("keeps every draft command behind its owner check", () => {
    backendDb = openBackendDb(":memory:");
    const posts = postService(backendDb);
    const draftId = posts.create(42, { text: "Private draft", textEn: "Private draft", entities: [], media: [] });

    expect(() => posts.get(7, draftId)).toThrow("not available");
    expect(() => posts.toggleTarget(7, draftId, "telegram")).toThrow("not available");
    expect(() => posts.publish(7, draftId)).toThrow("not available");
    expect(() => posts.cancel(7, draftId)).toThrow("not available");
    expect(() => posts.cancelRemaining(7, draftId)).toThrow("not available");
    expect(() => posts.progress(7, draftId)).toThrow("not available");
    expect(() => posts.scheduleChoice(7, draftId, "auto")).toThrow("not available");
    expect(() => posts.manualSchedule(7, draftId, "both", "21:15")).toThrow("not available");

    posts.toggleTarget(42, draftId, "telegram");
    expect(posts.get(42, draftId).id).toBe(draftId);
    expect(posts.progress(42, draftId).targets.length).toBeGreaterThan(0);
  });

  it("resolves automatic and manual plans before publishing them", () => {
    backendDb = openBackendDb(":memory:");
    const posts = postService(backendDb);
    const draftId = posts.create(42, { text: "Schedule", textEn: "Schedule", entities: [], media: [] });

    const automatic = posts.scheduleChoice(42, draftId, "auto");
    expect(automatic.ruAt).toBeInstanceOf(Date);
    expect(automatic.enAt).toBeInstanceOf(Date);
    const manual = posts.manualSchedule(42, draftId, "both", "23:15");
    expect(manual.ruAt?.getMinutes()).toBe(15);
    expect(manual.enAt?.getMinutes()).toBe(15);
  });
});
