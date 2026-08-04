import type { Menu } from "@grammyjs/menu";
import type { Context } from "grammy";
import type { PublicationPipeline } from "../application/publication-pipeline.js";
import type { BackendDb } from "../db/client.js";
import type { BackendConfig } from "../foundation/config.js";
import type { PublicationEffect } from "./effects.js";
import type { BotLocale } from "./i18n.js";
import type { PublicationCallback } from "./session-fsm.js";

export type CallbackRouterContext = {
  ctx: Context;
  backendDb: BackendDb;
  config: BackendConfig;
  actorId: number;
  locale: BotLocale;
  data: string;
  callback: PublicationCallback;
  action: string;
  revision: number | null;
  parts: string[];
  args: string[];
  mainMenu?: Menu<Context> | undefined;
};

export type PublicationActionContext = CallbackRouterContext & {
  first: string | undefined;
  second: string | undefined;
  draftId: number;
  mainMenu: Menu<Context> | undefined;
  pipeline: PublicationPipeline;
};

// biome-ignore lint/suspicious/noConfusingVoidType: action declarations intentionally return no effect on the normal path.
export type PublicationActionResult = readonly PublicationEffect[] | void;

export type PublicationActionHandler = (args: PublicationActionContext) => Promise<PublicationActionResult>;
