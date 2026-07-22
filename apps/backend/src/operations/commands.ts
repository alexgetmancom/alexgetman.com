import { z } from "zod";
import type { BackendDb } from "../db/client.js";
import { editPublishedTargets } from "../delivery/external-edits.js";
import { removePublishedTargets } from "../delivery/external-removals.js";
import type { BackendConfig } from "../foundation/config.js";
import { recordOperationAction } from "./action-audit.js";
import { editLocaleContent, parseEnglishMedia, refreshLocaleSite, replaceLocaleMedia } from "./commands/content-repair.js";
import { replaceTextFallbackTargets, requeueAfterRemoval, requeuePublicationScope } from "./commands/requeue.js";
import { resolvePublicationRef } from "./publication-ref.js";

/** Explicit maintenance command accepted by the Operations boundary. */
export const commandActionSchema = z.object({
  action: z.string().default(""),
  ref: z.string().optional(),
  message_id: z.coerce.number().optional(),
  target: z.string().optional(),
  locale: z.preprocess((value) => (value === "" ? undefined : value), z.enum(["ru", "en"]).optional()),
  text: z.string().optional(),
  media_json: z.string().optional(),
  text_en: z.string().optional(),
  media_en_json: z.string().optional(),
  token: z.string().optional(),
  actor_type: z.string().optional(),
});

export type CommandAction = z.infer<typeof commandActionSchema>;

/** Dispatches authorised Operations commands; persistence lives in command modules. */
export async function runOperationCommand(
  backendDb: BackendDb,
  input: CommandAction,
  config?: BackendConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<Record<string, unknown>> {
  const ref = input.ref || (input.message_id == null ? "" : String(input.message_id));
  if (!ref) throw new Error("missing publication ref");
  const publicationRef = resolvePublicationRef(backendDb, ref);
  if (!publicationRef) throw new Error(`publication not found: ${ref}`);
  let result: Record<string, unknown>;
  if (input.action === "retry" || input.action === "republish")
    result = requeuePublicationScope(backendDb, publicationRef, input.target, input.locale);
  else if (input.action === "refresh_site") {
    const locale = input.locale ?? "en";
    result = refreshLocaleSite(backendDb, publicationRef, locale);
  } else if (input.action === "edit" || input.action === "edit_en") {
    const locale = input.locale ?? "en";
    const text = input.text ?? input.text_en ?? "";
    result = editLocaleContent(backendDb, publicationRef, locale, text);
    if (config)
      result.external = await editPublishedTargets(
        backendDb,
        {
          postKey: publicationRef.postKey,
          textRu: locale === "ru" ? text : null,
          textEn: locale === "en" ? text : null,
          ...(input.target ? { target: input.target } : {}),
          locale,
        },
        config,
        fetchImpl,
      );
    if (config) result.replaced = await replaceTextFallbackTargets(backendDb, publicationRef, config, input.target, locale, fetchImpl);
  } else if (input.action === "replace_media" || input.action === "replace_en_media") {
    const locale = input.locale ?? "en";
    result = replaceLocaleMedia(backendDb, publicationRef, locale, parseEnglishMedia(input.media_json ?? input.media_en_json));
    if (config) {
      result.removed = await removePublishedTargets(
        backendDb,
        config,
        { postKey: publicationRef.postKey, ...(input.target ? { target: input.target } : {}), locale },
        fetchImpl,
      );
      result.republish = requeueAfterRemoval(backendDb, publicationRef, result.removed as Array<Record<string, unknown>>, input.target);
    } else result.republish = requeuePublicationScope(backendDb, publicationRef, input.target, locale);
  } else if (input.action === "use_other_media" || input.action === "use_ru_media_for_en") {
    const locale = input.locale ?? "en";
    result = replaceLocaleMedia(backendDb, publicationRef, locale, null);
    result.republish = requeuePublicationScope(backendDb, publicationRef, input.target, locale);
  } else if (input.action === "delete" || input.action === "delete_republish") {
    if (!config) throw new Error("external removal requires runtime config");
    result = {
      ok: true,
      removed: await removePublishedTargets(
        backendDb,
        config,
        {
          postKey: publicationRef.postKey,
          ...(input.target ? { target: input.target } : {}),
          ...(input.locale ? { locale: input.locale } : {}),
        },
        fetchImpl,
      ),
    };
    if (input.action === "delete_republish")
      result.republish = requeueAfterRemoval(backendDb, publicationRef, result.removed as Array<Record<string, unknown>>, input.target);
  } else throw new Error(`unknown action: ${input.action}`);
  recordOperationAction(backendDb, input.action, publicationRef, input.target ?? null, result, input.actor_type ?? "command-center");
  return result;
}
