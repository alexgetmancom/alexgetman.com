import { afterEach, describe, expect, it } from "bun:test";
import type { BackendDb } from "../src/db/client.js";
import { openBackendDb } from "../src/db/client.js";
import { loadConfig } from "../src/foundation/config.js";
import { postService } from "../src/studio/services/posts.js";

let backendDb: BackendDb | null = null;

afterEach(() => {
  backendDb?.close();
  backendDb = null;
});

describe("Studio post commands", () => {
  it("shares draft commands with configured Studio admins and rejects outsiders", () => {
    backendDb = openBackendDb(":memory:");
    const posts = postService(backendDb, loadConfig({ ADMIN_IDS: "42,7" }));
    const draftId = posts.create(42, { text: "Private draft", textEn: "Private draft", entities: [], media: [] });

    expect(posts.get(7, draftId).id).toBe(draftId);
    posts.toggleTarget(7, draftId, "telegram");
    expect(() => posts.get(9, draftId)).toThrow("err.post-not-yours");
    expect(() => posts.publish(9, draftId)).toThrow("err.post-not-yours");
    expect(() => posts.cancel(9, draftId)).toThrow("err.post-not-yours");

    expect(posts.get(42, draftId).id).toBe(draftId);
    expect(posts.progress(42, draftId).targets.length).toBeGreaterThan(0);
  });

  it("resolves manual schedule plans before publishing them", () => {
    backendDb = openBackendDb(":memory:");
    const posts = postService(backendDb, loadConfig({ ADMIN_IDS: "42" }));
    const draftId = posts.create(42, { text: "Schedule", textEn: "Schedule", entities: [], media: [] });

    const manual = posts.manualSchedule(42, draftId, "both", "23:15");
    expect(manual.ruAt?.getMinutes()).toBe(15);
    expect(manual.enAt?.getMinutes()).toBe(15);
  });
});
