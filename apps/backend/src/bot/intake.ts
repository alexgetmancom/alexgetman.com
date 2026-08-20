import type { Context } from "grammy";
import { InlineKeyboard } from "grammy";
import { parseMarkdownArticle } from "../content/markdown.js";
import type { BackendDb } from "../db/client.js";
import type { BackendConfig } from "../foundation/config.js";
import { t } from "../foundation/i18n/index.js";
import { publishArticle } from "../publishing/article-publish.js";
import { settingsService } from "../studio/services/settings.js";
import { clearConversationState, getConversationState, saveConversationState } from "./conversation-state.js";
import { cancelPromptKeyboard } from "./dialog-ui.js";
import { executePublicationEffects, type PublicationMessageResult } from "./effects.js";

const MARKDOWN_EXTENSIONS = [".md", ".markdown", ".mdx"];
const INTAKE_CANCEL = "intake_cancel";
export const INTAKE_ARTICLE_PUBLISH = "intake_article_publish";

/** The one entry point for new material. What arrives decides what it becomes:
 * a Markdown file is an article, a video is a video publication, and anything
 * else is a post. The operator is not asked to classify their own file. */
export async function openIntake(ctx: Context, backendDb: BackendDb, mode: "reply" | "edit" = "reply"): Promise<void> {
  const actorId = Number(ctx.from?.id);
  const locale = settingsService(backendDb).locale(actorId);
  saveConversationState(backendDb, actorId, { kind: "intake", draftId: null, step: "awaiting", data: {}, controlMessageId: null });
  await executePublicationEffects(ctx, backendDb, [
    {
      type: "screen",
      mode,
      text: t(locale, "intake.prompt"),
      options: { reply_markup: cancelPromptKeyboard(locale, INTAKE_CANCEL) },
    },
  ]);
}

/** Consumes the first message of an intake, or declines it so the ordinary
 * post and video handlers see it unchanged. */
export async function handleIntakeMessage(ctx: Context, backendDb: BackendDb, config: BackendConfig): Promise<PublicationMessageResult> {
  const actorId = Number(ctx.from?.id);
  if (!getConversationState(backendDb, actorId, "intake")) return { handled: false, effects: [] };
  const locale = settingsService(backendDb).locale(actorId);
  const document = ctx.message && "document" in ctx.message ? ctx.message.document : undefined;
  const name = (document?.file_name ?? "").toLowerCase();
  const isMarkdown =
    document !== undefined &&
    ((document.mime_type ?? "").startsWith("text/markdown") || MARKDOWN_EXTENSIONS.some((extension) => name.endsWith(extension)));
  if (!isMarkdown) {
    // Not an article, so it is a post. The intake hands the same message on
    // rather than answering it: the post screen owns albums, media and
    // translation, and none of that is worth a second implementation here.
    saveConversationState(backendDb, actorId, { kind: "post", draftId: null, step: "new_post", data: {}, controlMessageId: null });
    return { handled: false, effects: [] };
  }

  const markdown = await downloadDocument(ctx, config, document.file_id);
  const { title, body } = parseMarkdownArticle(markdown);
  if (!title) {
    return { handled: true, effects: [{ type: "screen", mode: "reply", text: t(locale, "intake.article-untitled") }] };
  }
  saveConversationState(backendDb, actorId, {
    kind: "intake",
    draftId: null,
    step: "article_review",
    data: { markdown },
    controlMessageId: null,
  });
  const summary = t(locale, "intake.article-review", { title, characters: String(body.text.length) });
  return {
    handled: true,
    effects: [
      {
        type: "screen",
        mode: "reply",
        text: summary,
        options: {
          reply_markup: new InlineKeyboard()
            .text(t(locale, "intake.article-publish"), INTAKE_ARTICLE_PUBLISH)
            .row()
            .text(t(locale, "common.cancel"), INTAKE_CANCEL),
        },
      },
    ],
  };
}

/** Publishes the reviewed article to every connected target that carries one. */
export function publishReviewedArticle(backendDb: BackendDb, config: BackendConfig, actorId: number): { title: string } {
  const state = getConversationState(backendDb, actorId, "intake");
  const markdown = typeof state?.data.markdown === "string" ? state.data.markdown : "";
  if (state?.step !== "article_review" || !markdown) throw new Error("no article is waiting to be published");
  const result = publishArticle(backendDb, config, { locale: "en", targets: ["x_article"], markdown }) as { title: string };
  clearConversationState(backendDb, actorId, "intake");
  return result;
}

export function cancelIntake(backendDb: BackendDb, actorId: number): void {
  clearConversationState(backendDb, actorId, "intake");
}

async function downloadDocument(ctx: Context, config: BackendConfig, fileId: string): Promise<string> {
  if (!config.controllerBotToken) throw new Error("Telegram bot token is not configured.");
  const file = await ctx.api.getFile(fileId);
  if (!file.file_path) throw new Error("Telegram did not return a file path.");
  const base = config.TELEGRAM_API_BASE_URL.replace(/\/$/, "");
  const response = await fetch(`${base}/file/bot${config.controllerBotToken}/${file.file_path}`);
  if (!response.ok) throw new Error(`Telegram file download failed: ${response.status}`);
  return response.text();
}
