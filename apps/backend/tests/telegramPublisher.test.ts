import { describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { publishToTelegram } from "../src/delivery/social/telegram.js";
import { loadTestConfig } from "./helpers/studio-config.js";

/**
 * The Telegram publisher is the one every text and photo post goes through,
 * and its whole job is assembling a request Telegram will accept. These tests
 * assert on the request it builds, because that is where the failures live:
 * a caption entity pointing past the truncated caption, a link preview that
 * silently disappears, an album that uploads local bytes instead of file ids.
 */

const config = loadTestConfig({
  CONTROLLER_BOT_TOKEN: "bot-token",
  TELEGRAM_API_BASE_URL: "https://telegram.local/",
  TELEGRAM_CHANNEL_USERNAME: "alexgetmancom",
});

type Call = { method: string; json?: Record<string, unknown>; form?: FormData };

/** Records what the publisher sends and replies with a plausible Bot API body. */
function recorder(reply: (method: string) => unknown = () => ({ ok: true, result: { message_id: 42 } })) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const method = String(input).split("/").pop() ?? "";
    const body = init?.body;
    calls.push(body instanceof FormData ? { method, form: body } : { method, json: JSON.parse(String(body)) });
    return new Response(JSON.stringify(reply(method)), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl, call: (method: string) => calls.find((entry) => entry.method === method) };
}

describe("publishToTelegram", () => {
  it("skips instead of failing when no bot token is configured", async () => {
    const result = await publishToTelegram({ text: "hi" }, loadTestConfig({ TELEGRAM_CHANNEL_USERNAME: "alexgetmancom" }), (() => {
      throw new Error("must not call Telegram");
    }) as unknown as typeof fetch);
    expect(result).toEqual({ skipped: true, reason: "missing Telegram bot token" });
  });

  it("posts text to the configured channel and reports the public message URL", async () => {
    const { calls, fetchImpl, call } = recorder();
    const result = await publishToTelegram({ text: "hello" }, config, fetchImpl);

    expect(call("sendMessage")?.json).toMatchObject({ chat_id: "@alexgetmancom", text: "hello" });
    expect(result.ok).toBe(true);
    expect(result.url).toBe("https://t.me/alexgetmancom/42");
    // The heart reaction is a courtesy, but it must be attached to the message
    // that was actually published.
    expect(call("setMessageReaction")?.json).toMatchObject({ chat_id: "@alexgetmancom", message_id: 42 });
    expect(calls.map((entry) => entry.method)).toEqual(["sendMessage", "setMessageReaction"]);
  });

  it("keeps the post published when the optional reaction is rejected", async () => {
    const { fetchImpl } = recorder((method) =>
      method === "setMessageReaction" ? { ok: false, description: "not enough rights" } : { ok: true, result: { message_id: 7 } },
    );
    const result = await publishToTelegram({ text: "hello" }, config, fetchImpl);
    expect(result.ok).toBe(true);
    expect(result.id).toBe(7);
  });

  it("asks for a small link preview of the first real text_link entity", async () => {
    const { fetchImpl, call } = recorder();
    await publishToTelegram(
      {
        text: "see this",
        entities: [
          { type: "bold", offset: 0, length: 3 },
          { type: "text_link", url: "javascript:alert(1)" },
          { type: "text_link", url: "https://alexgetman.com/post" },
        ],
      },
      config,
      fetchImpl,
    );
    expect(call("sendMessage")?.json?.link_preview_options).toEqual({
      url: "https://alexgetman.com/post",
      prefer_small_media: true,
      show_above_text: false,
    });
  });

  it("falls back to the default preview when no entity carries a usable link", async () => {
    const { fetchImpl, call } = recorder();
    await publishToTelegram({ text: "plain", entities: [{ type: "bold", offset: 0, length: 5 }] }, config, fetchImpl);
    const sent = call("sendMessage")?.json;
    expect(sent?.link_preview_options).toBeUndefined();
    expect(sent?.disable_web_page_preview).toBe(false);
  });

  it("clamps caption entities to the truncated caption instead of sending offsets past its end", async () => {
    const { fetchImpl, call } = recorder();
    const text = "x".repeat(1200);
    await publishToTelegram(
      {
        text,
        media: [{ type: "IMAGE", fileId: "file-1" }],
        // One entity survives clamped, one starts beyond the 1024 limit and
        // must be dropped: Telegram rejects the whole message otherwise.
        entities: [
          { type: "bold", offset: 1020, length: 100 },
          { type: "italic", offset: 1100, length: 10 },
        ],
      },
      config,
      fetchImpl,
    );
    const sent = call("sendPhoto")?.json;
    expect(String(sent?.caption)).toHaveLength(1024);
    expect(sent?.caption_entities).toEqual([{ type: "bold", offset: 1020, length: 4 }]);
  });

  it("does not split a surrogate pair at the caption boundary", async () => {
    const { fetchImpl, call } = recorder();
    // Emoji straddling the 1024th UTF-16 unit: keeping half of it produces a
    // replacement character in the published caption.
    await publishToTelegram({ text: `${"x".repeat(1023)}😀tail`, media: [{ type: "IMAGE", fileId: "f" }] }, config, fetchImpl);
    const caption = String(call("sendPhoto")?.json?.caption);
    expect(caption).toHaveLength(1023);
    expect(caption.endsWith("x")).toBe(true);
  });

  it("prefers a file id over re-uploading bytes, and uses sendVideo for video", async () => {
    const { fetchImpl, call } = recorder();
    await publishToTelegram(
      { text: "clip", media: [{ type: "VIDEO", fileId: "reused-id", localPath: "/does/not/exist" }] },
      config,
      fetchImpl,
    );
    expect(call("sendVideo")?.json).toMatchObject({ video: "reused-id" });
    expect(call("sendVideo")?.form).toBeUndefined();
  });

  it("uploads local bytes as a multipart attachment when there is no file id or URL", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "telegram-publisher-"));
    try {
      const file = path.join(dir, "photo.jpg");
      fs.writeFileSync(file, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
      const { fetchImpl, call } = recorder();
      await publishToTelegram({ text: "shot", media: [{ type: "IMAGE", localPath: file }] }, config, fetchImpl);
      const form = call("sendPhoto")?.form;
      expect(form?.get("photo")).toBe("attach://file-photo");
      expect(form?.get("file-photo")).toBeInstanceOf(Blob);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sends an album as one media group, captioning only its first item", async () => {
    const { fetchImpl, call } = recorder(() => ({ ok: true, result: [{ message_id: 11 }, { message_id: 12 }] }));
    await publishToTelegram(
      {
        text: "album",
        media: [
          { type: "IMAGE", fileId: "a" },
          { type: "VIDEO", fileId: "b" },
        ],
      },
      config,
      fetchImpl,
    );
    const items = call("sendMediaGroup")?.json?.media as Record<string, unknown>[];
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ type: "photo", media: "a", caption: "album" });
    expect(items[1]).toMatchObject({ type: "video", media: "b" });
    expect(items[1]?.caption).toBeUndefined();
  });

  it("caps an album at the ten items Telegram accepts", async () => {
    const { fetchImpl, call } = recorder(() => ({ ok: true, result: [{ message_id: 1 }] }));
    const media = Array.from({ length: 14 }, (_, index) => ({ type: "IMAGE" as const, fileId: `f${index}` }));
    await publishToTelegram({ text: "big album", media }, config, fetchImpl);
    expect(call("sendMediaGroup")?.json?.media).toHaveLength(10);
  });

  it("reports every message id of an album and links the first", async () => {
    const { fetchImpl } = recorder(() => ({ ok: true, result: [{ message_id: 11 }, { message_id: 12 }] }));
    const result = await publishToTelegram(
      {
        text: "album",
        media: [
          { type: "IMAGE", fileId: "a" },
          { type: "IMAGE", fileId: "b" },
        ],
      },
      config,
      fetchImpl,
    );
    expect(result.ids).toEqual([11, 12]);
    expect(result.url).toBe("https://t.me/alexgetmancom/11");
  });

  it("surfaces the Bot API description when the call is refused", async () => {
    const { calls, fetchImpl } = recorder(() => ({ ok: false, description: "chat not found" }));
    const result = await publishToTelegram({ text: "hello" }, config, fetchImpl);
    expect(result).toEqual({ ok: false, error: "chat not found" });
    // A failed publish must not be reacted to.
    expect(calls.map((entry) => entry.method)).toEqual(["sendMessage"]);
  });
});
