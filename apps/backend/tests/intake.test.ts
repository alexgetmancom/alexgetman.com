import { describe, expect, it } from "bun:test";
import { getConversationState } from "../src/bot/conversation-state.js";
import { applyIntakeKind, handleIntakeMessage, openIntake, publishReviewedArticle } from "../src/bot/intake.js";
import { registerTestChannels } from "./helpers/channels.js";
import { openBackendDb } from "./helpers/open-db.js";
import { loadTestConfig } from "./helpers/studio-config.js";

const config = loadTestConfig({ CONTROLLER_BOT_TOKEN: "bot-token", CONTROLLER_ADMIN_IDS: "42" });
const article = "# Chapter one\n\nBody with a **bold** word.";

function ctxWith(message: Record<string, unknown>) {
  return {
    from: { id: 42 },
    chat: { id: 42 },
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

function buttonRows(effect: { options?: Record<string, unknown> }): string[] {
  const markup = effect.options?.reply_markup as { inline_keyboard?: Array<Array<{ text: string }>> } | undefined;
  return (markup?.inline_keyboard ?? []).flat().map((button) => button.text);
}

async function capture(backendDb: ReturnType<typeof openBackendDb>, message: Record<string, unknown>) {
  await openIntake(ctxWith({ text: "" }), backendDb);
  return handleIntakeMessage(ctxWith(message), backendDb, config);
}

describe("bot intake", () => {
  it("captures the material first and asks what it is, without choosing", async () => {
    const backendDb = openBackendDb(":memory:");
    try {
      const result = await capture(backendDb, { text: "A long enough thought." });
      expect(result.handled).toBe(true);
      expect(getConversationState(backendDb, 42, "intake")?.step).toBe("choose");
      expect(buttonRows(result.effects[0] as never)).toEqual(["📝 Post", "📄 Article", "← Cancel"]);
    } finally {
      backendDb.close();
    }
  });

  it("shows the size rather than deciding by it: a short text still offers both kinds", async () => {
    const backendDb = openBackendDb(":memory:");
    try {
      const short = await capture(backendDb, { text: "Tiny." });
      expect((short.effects[0] as { text: string }).text).toContain("5 characters");
      expect(buttonRows(short.effects[0] as never)).toContain("📄 Article");
      const long = await capture(backendDb, { text: "x".repeat(4000) });
      expect(buttonRows(long.effects[0] as never)).toContain("📝 Post");
    } finally {
      backendDb.close();
    }
  });

  it("offers a video publication only when a video actually arrived, and never an Article for it", async () => {
    const backendDb = openBackendDb(":memory:");
    try {
      const withVideo = await capture(backendDb, { video: { file_id: "v1", width: 1, height: 1, duration: 1 }, caption: "clip" });
      expect(buttonRows(withVideo.effects[0] as never)).toEqual(["📝 Post", "🎬 Video publication", "← Cancel"]);
      const withoutVideo = await capture(backendDb, { text: "no file here" });
      expect(buttonRows(withoutVideo.effects[0] as never)).not.toContain("🎬 Video publication");
    } finally {
      backendDb.close();
    }
  });

  it("offers both kinds for a markdown file, because a file can be a long post", async () => {
    const backendDb = openBackendDb(":memory:");
    const restore = stubDownload(article);
    try {
      const result = await capture(backendDb, { document: { file_id: "f1", file_name: "post.md" } });
      expect(buttonRows(result.effects[0] as never)).toEqual(["📝 Post", "📄 Article", "← Cancel"]);
    } finally {
      restore();
      backendDb.close();
    }
  });

  it("takes the first line as the title when the material has no heading, and shows it", async () => {
    const backendDb = openBackendDb(":memory:");
    try {
      await capture(backendDb, { text: "Why delivery settles\n\nThe body of it." });
      const [review] = await applyIntakeKind(ctxWith({}), backendDb, config, "article");
      expect((review as { text: string }).text).toContain("Why delivery settles");
      expect(getConversationState(backendDb, 42, "intake")?.step).toBe("article_review");
    } finally {
      backendDb.close();
    }
  });

  it("publishes a confirmed article and closes the intake", async () => {
    const backendDb = openBackendDb(":memory:");
    registerTestChannels(backendDb, ["x"]);
    const restore = stubDownload(article);
    try {
      await capture(backendDb, { document: { file_id: "f2", file_name: "post.md" } });
      await applyIntakeKind(ctxWith({}), backendDb, config, "article");
      expect(publishReviewedArticle(backendDb, config, 42)).toMatchObject({ title: "Chapter one" });
      expect(getConversationState(backendDb, 42, "intake")).toBeNull();
      expect(backendDb.sqlite.query("SELECT target FROM publish_jobs").all()).toEqual([{ target: "x_article" }]);
    } finally {
      restore();
      backendDb.close();
    }
  });

  it("turns the captured material into a post draft and closes the intake", async () => {
    const backendDb = openBackendDb(":memory:");
    try {
      await capture(backendDb, { text: "an ordinary post" });
      const effects = await applyIntakeKind(ctxWith({}), backendDb, config, "post");
      expect(effects[0]).toMatchObject({ card: { kind: "post" } });
      expect(getConversationState(backendDb, 42, "intake")).toBeNull();
      expect(backendDb.sqlite.query("SELECT text_ru FROM drafts").all()).toEqual([{ text_ru: "an ordinary post" }]);
    } finally {
      backendDb.close();
    }
  });

  it("stays out of the way when no intake is open", async () => {
    const backendDb = openBackendDb(":memory:");
    try {
      const result = await handleIntakeMessage(ctxWith({ text: "stray" }), backendDb, config);
      expect(result.handled).toBe(false);
    } finally {
      backendDb.close();
    }
  });
});
