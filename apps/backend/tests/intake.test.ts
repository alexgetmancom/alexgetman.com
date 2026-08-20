import { describe, expect, it } from "bun:test";
import { getConversationState } from "../src/bot/conversation-state.js";
import { handleIntakeMessage, openIntake, publishReviewedArticle } from "../src/bot/intake.js";
import { registerTestChannels } from "./helpers/channels.js";
import { openBackendDb } from "./helpers/open-db.js";
import { loadTestConfig } from "./helpers/studio-config.js";

const config = loadTestConfig({ CONTROLLER_BOT_TOKEN: "bot-token", CONTROLLER_ADMIN_IDS: "42" });
const article = "# Chapter one\n\nBody with a **bold** word.";

/** A grammy context stub carrying exactly what the intake reads. */
function ctxWith(message: Record<string, unknown>) {
  return {
    from: { id: 42 },
    message,
    api: { getFile: async () => ({ file_path: "documents/file.md" }) },
    reply: async () => undefined,
  } as never;
}

function stubDownload(body: string): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = Object.assign(async () => new Response(body), { preconnect: original.preconnect }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

describe("bot intake", () => {
  it("turns a markdown document into an article waiting for confirmation", async () => {
    const backendDb = openBackendDb(":memory:");
    const restore = stubDownload(article);
    try {
      await openIntake(ctxWith({ text: "" }), backendDb);
      const result = await handleIntakeMessage(ctxWith({ document: { file_id: "f1", file_name: "post.md" } }), backendDb, config);
      expect(result.handled).toBe(true);
      const state = getConversationState(backendDb, 42, "intake");
      expect(state?.step).toBe("article_review");
      expect(state?.data.markdown).toBe(article);
    } finally {
      restore();
      backendDb.close();
    }
  });

  it("refuses a titleless file and keeps the intake open for another one", async () => {
    const backendDb = openBackendDb(":memory:");
    const restore = stubDownload("Just prose.");
    try {
      await openIntake(ctxWith({ text: "" }), backendDb);
      const result = await handleIntakeMessage(ctxWith({ document: { file_id: "f2", file_name: "notes.md" } }), backendDb, config);
      expect(result.handled).toBe(true);
      expect(getConversationState(backendDb, 42, "intake")?.step).toBe("awaiting");
    } finally {
      restore();
      backendDb.close();
    }
  });

  it("hands anything that is not an article to the post screen, message and all", async () => {
    const backendDb = openBackendDb(":memory:");
    try {
      await openIntake(ctxWith({ text: "" }), backendDb);
      const result = await handleIntakeMessage(ctxWith({ text: "an ordinary post" }), backendDb, config);
      expect(result.handled).toBe(false);
      expect(getConversationState(backendDb, 42, "post")?.step).toBe("new_post");
      expect(getConversationState(backendDb, 42, "intake")).toBeNull();
    } finally {
      backendDb.close();
    }
  });

  it("stays out of the way when no intake is open", async () => {
    const backendDb = openBackendDb(":memory:");
    try {
      const result = await handleIntakeMessage(ctxWith({ document: { file_id: "f3", file_name: "post.md" } }), backendDb, config);
      expect(result.handled).toBe(false);
    } finally {
      backendDb.close();
    }
  });

  it("publishes the reviewed article and closes the intake", async () => {
    const backendDb = openBackendDb(":memory:");
    registerTestChannels(backendDb, ["x"]);
    const restore = stubDownload(article);
    try {
      await openIntake(ctxWith({ text: "" }), backendDb);
      await handleIntakeMessage(ctxWith({ document: { file_id: "f4", file_name: "post.md" } }), backendDb, config);
      expect(publishReviewedArticle(backendDb, config, 42)).toMatchObject({ title: "Chapter one" });
      expect(getConversationState(backendDb, 42, "intake")).toBeNull();
      expect(backendDb.sqlite.query("SELECT target FROM publish_jobs").all()).toEqual([{ target: "x_article" }]);
    } finally {
      restore();
      backendDb.close();
    }
  });
});
