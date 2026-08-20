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
  it("makes a short text a post without asking and without offering to undo it", async () => {
    const backendDb = openBackendDb(":memory:");
    try {
      const result = await capture(backendDb, { text: "Short enough to be obvious." });
      expect(result.effects[0]).toMatchObject({ card: { kind: "post" } });
      // An article is written long or written in a file. Neither is true here,
      // so this is not a close call and carries no way back.
      expect(buttonRows(result.effects[0] as never)).not.toContain("📄 Actually, this is an article");
      expect(getConversationState(backendDb, 42, "intake")).toBeNull();
      expect(backendDb.sqlite.query("SELECT count(*) AS count FROM drafts").get()).toEqual({ count: 1 });
    } finally {
      backendDb.close();
    }
  });

  it("asks once the text is long enough for both readings to be live", async () => {
    const backendDb = openBackendDb(":memory:");
    try {
      const result = await capture(backendDb, { text: "x".repeat(901) });
      expect(getConversationState(backendDb, 42, "intake")?.step).toBe("choose");
      expect(buttonRows(result.effects[0] as never)).toEqual(["📝 Post", "📄 Article", "← Cancel"]);
    } finally {
      backendDb.close();
    }
  });

  it("takes a captioned video as an open question and a bare one as a video publication", async () => {
    const backendDb = openBackendDb(":memory:");
    try {
      const captioned = await capture(backendDb, {
        document: { file_id: "v1", file_name: "clip.mp4", mime_type: "video/mp4" },
        caption: "look",
      });
      expect(buttonRows(captioned.effects[0] as never)).toEqual(["📝 Post", "🎬 Video publication", "← Cancel"]);
      const bare = await capture(backendDb, { document: { file_id: "v2", file_name: "clip.mp4", mime_type: "video/mp4" } });
      expect(getConversationState(backendDb, 42, "intake")?.step).toBe("video_locale");
      // A post always carries its text; a video sent without any is not one.
      expect(buttonRows(bare.effects[0] as never)).not.toContain("📝 Actually, this is a post");
    } finally {
      backendDb.close();
    }
  });

  it("does not download a bare video until the language is answered", async () => {
    const backendDb = openBackendDb(":memory:");
    try {
      await capture(backendDb, { document: { file_id: "v3", file_name: "clip.mp4", mime_type: "video/mp4" } });
      expect(backendDb.sqlite.query("SELECT count(*) AS count FROM studio_media_assets").get()).toEqual({ count: 0 });
    } finally {
      backendDb.close();
    }
  });

  it("makes a markdown file an article without asking, and offers the post reading back", async () => {
    const backendDb = openBackendDb(":memory:");
    const restore = stubDownload(article);
    try {
      const result = await capture(backendDb, { document: { file_id: "f1", file_name: "post.md" } });
      expect(getConversationState(backendDb, 42, "intake")?.step).toBe("article_review");
      expect(buttonRows(result.effects[0] as never)).toContain("📝 Actually, this is a post");
    } finally {
      restore();
      backendDb.close();
    }
  });

  it("takes the first line as the title when the material has no heading, and shows it", async () => {
    const backendDb = openBackendDb(":memory:");
    try {
      await capture(backendDb, { text: `Why delivery settles\n\n${"x".repeat(901)}` });
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
      await capture(backendDb, { text: "x".repeat(901) });
      const effects = await applyIntakeKind(ctxWith({}), backendDb, config, "post");
      expect(effects[0]).toMatchObject({ card: { kind: "post" } });
      expect(getConversationState(backendDb, 42, "intake")).toBeNull();
      expect(backendDb.sqlite.query("SELECT text_ru FROM drafts").all()).toEqual([{ text_ru: "x".repeat(901) }]);
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
