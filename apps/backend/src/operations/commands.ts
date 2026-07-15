import type { BackendDb } from "../db/client.js";
import { editPublishedTargets } from "../delivery/external-edits.js";
import type { BackendConfig } from "../foundation/config.js";
import { recordOperationAction } from "./action-audit.js";
import { editEnglishContent, parseEnglishMedia, replaceEnglishMedia } from "./commands/content-repair.js";
import { requeuePublication } from "./commands/requeue.js";
import { resolvePublicationRef } from "./publication-ref.js";

/** Explicit maintenance command accepted by the Operations boundary. */
export type CommandAction = {
  action: string;
  ref?: string;
  message_id?: number;
  target?: string;
  text_en?: string;
  media_en_json?: string;
  token?: string;
  actor_type?: string;
};

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
  if (input.action === "retry" || input.action === "republish") result = requeuePublication(backendDb, publicationRef, input.target);
  else if (input.action === "edit_en") {
    result = editEnglishContent(backendDb, publicationRef, input.text_en ?? "");
    if (config)
      result.external = await editPublishedTargets(
        backendDb,
        { postKey: publicationRef.postKey, textRu: null, textEn: input.text_en ?? "" },
        config,
        fetchImpl,
      );
  } else if (input.action === "replace_en_media")
    result = replaceEnglishMedia(backendDb, publicationRef, parseEnglishMedia(input.media_en_json));
  else if (input.action === "use_ru_media_for_en") result = replaceEnglishMedia(backendDb, publicationRef, null);
  else throw new Error(`unknown action: ${input.action}`);
  recordOperationAction(backendDb, input.action, publicationRef, input.target ?? null, result, input.actor_type ?? "command-center");
  return result;
}
