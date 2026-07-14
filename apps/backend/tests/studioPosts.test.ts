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

    expect(() => posts.details(7, draftId)).toThrow("not available");
    expect(() => posts.toggleTarget(7, draftId, "telegram")).toThrow("not available");
    expect(() => posts.publishNow(7, draftId)).toThrow("not available");
    expect(() => posts.cancel(7, draftId)).toThrow("not available");
    expect(() => posts.cancelRemaining(7, draftId)).toThrow("not available");
    expect(() => posts.progress(7, draftId)).toThrow("not available");

    posts.toggleTarget(42, draftId, "telegram");
    expect(posts.details(42, draftId).id).toBe(draftId);
    expect(posts.progress(42, draftId).targets.length).toBeGreaterThan(0);
  });
});
