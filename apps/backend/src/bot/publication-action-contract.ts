import type { Menu } from "@grammyjs/menu";
import type { Context } from "grammy";
import type { PublicationPipeline } from "../application/publication-pipeline.js";
import type { BackendDb } from "../db/client.js";
import type { BackendConfig } from "../foundation/config.js";
import type { StudioServices } from "../studio/services/index.js";
import type { PublicationEffect } from "./effects.js";
import type { BotLocale } from "./i18n.js";
import type { PublicationCallback } from "./publication-callback.js";
import type { PublicationRenderer } from "./publication-renderers.js";

export type PublicationActionContext = {
  ctx: Context;
  backendDb: BackendDb;
  config: BackendConfig;
  actorId: number;
  locale: BotLocale;
  callback: PublicationCallback;
  action: string;
  revision: number | null;
  args: Record<string, string | undefined>;
  mainMenu: Menu<Context> | undefined;
  pipeline: PublicationPipeline;
  services: StudioServices;
  renderer: PublicationRenderer;
  invalidEntityCode: string;
};

/** Context of an action declared with `entity: "draft"`: the router resolved a real draft id. */
export type PublicationDraftActionContext = PublicationActionContext & { draftId: number };

export type PublicationActionResult = readonly PublicationEffect[] | undefined;
export type PublicationActionHandler = (context: PublicationDraftActionContext) => Promise<PublicationActionResult>;
type PublicationActionEntity = "draft" | "session" | "none";

export type PublicationActionDefinition = {
  handler: PublicationActionHandler;
  entity: PublicationActionEntity;
  args: readonly string[];
  freshCard?: true;
  sessionRevision?: true;
};

export function action(
  handler: PublicationActionHandler,
  options: Omit<PublicationActionDefinition, "handler">,
): PublicationActionDefinition {
  return { handler, ...options };
}
