import type { BackendDb } from "../db/client.js";
import { recordDomainEvent } from "../domain/events.js";
import type { BackendConfig } from "../foundation/config.js";
import { type StudioServices, studioServices } from "../studio/services/index.js";

const feedbackHits = new Map<string, number[]>();
const publicTools = [
  {
    name: "submit_feedback",
    description: "Send feedback or a bug report to Alex Getman.",
    inputSchema: { type: "object", properties: { name: { type: "string" }, message: { type: "string" } }, required: ["message"] },
  },
];
const studioTools = [
  tool("studio_capabilities", "Read enabled Studio modules and sanitized platform readiness before selecting a command."),
  tool("studio_queue", "Read the authenticated owner's upcoming work, drafts and failures."),
  tool("studio_notifications", "Read the authenticated owner's durable Studio notification inbox.", { limit: integerSchema(1, 100) }),
  tool("studio_media_list", "List the authenticated owner's reusable Studio media assets.", { limit: integerSchema(1, 100) }),
  tool("studio_acknowledge_notification", "Mark one visible Studio notification as read.", { id: integerSchema(1) }, ["id"]),
  tool(
    "studio_post_create",
    "Create a text-post draft for the authenticated owner.",
    { text: stringSchema(1, 20_000), text_en: stringSchema(0, 20_000) },
    ["text"],
  ),
  tool("studio_post_get", "Read one owned post draft.", { draft_id: integerSchema(1) }, ["draft_id"]),
  tool(
    "studio_post_attach_media",
    "Attach already uploaded Studio media assets to an owned post locale. Upload files through POST /api/studio/media first.",
    {
      draft_id: integerSchema(1),
      locale: enumSchema(["ru", "en"]),
      asset_ids: { type: "array", items: integerSchema(1), minItems: 1, maxItems: 10 },
      replace: { type: "boolean" },
    },
    ["draft_id", "locale", "asset_ids"],
  ),
  tool("studio_post_preview", "Read a transport-neutral preview of one owned post draft.", { draft_id: integerSchema(1) }, ["draft_id"]),
  tool(
    "studio_post_edit",
    "Edit text on one owned post draft.",
    { draft_id: integerSchema(1), locale: enumSchema(["ru", "en"]), text: stringSchema(0, 20_000) },
    ["draft_id", "locale", "text"],
  ),
  tool(
    "studio_post_toggle_target",
    "Toggle one configured target on an owned post draft.",
    { draft_id: integerSchema(1), target: stringSchema(1, 120) },
    ["draft_id", "target"],
  ),
  tool("studio_post_publish", "Queue an owned post draft for immediate publication.", { draft_id: integerSchema(1) }, ["draft_id"]),
  tool(
    "studio_post_schedule",
    "Schedule an owned post draft. ISO dates are optional per locale.",
    { draft_id: integerSchema(1), ru_at: stringSchema(0, 80), en_at: stringSchema(0, 80) },
    ["draft_id"],
  ),
  tool("studio_post_cancel", "Cancel an owned post draft and its remaining work.", { draft_id: integerSchema(1) }, ["draft_id"]),
  tool("studio_video_create", "Create an owned video draft from an already-uploaded Studio asset.", { asset_key: stringSchema(1, 120) }, [
    "asset_key",
  ]),
  tool("studio_video_get", "Read an owned video draft and its targets.", { video_draft_id: integerSchema(1) }, ["video_draft_id"]),
  tool("studio_video_rename", "Rename an owned video draft.", { video_draft_id: integerSchema(1), label: stringSchema(1, 500) }, [
    "video_draft_id",
    "label",
  ]),
  tool(
    "studio_video_replace_targets",
    "Replace editable video publication targets.",
    {
      video_draft_id: integerSchema(1),
      targets: { type: "array", items: enumSchema(["youtube_shorts", "instagram_reels"]), minItems: 1, maxItems: 2 },
    },
    ["video_draft_id", "targets"],
  ),
  tool(
    "studio_video_update_metadata",
    "Set target metadata. YouTube requires title, description and tags; Instagram requires caption.",
    { video_draft_id: integerSchema(1), target: enumSchema(["youtube_shorts", "instagram_reels"]), metadata: { type: "object" } },
    ["video_draft_id", "target", "metadata"],
  ),
  tool(
    "studio_video_schedule",
    "Schedule one or both configured video targets at future ISO datetimes.",
    { video_draft_id: integerSchema(1), youtube_shorts_at: stringSchema(0, 80), instagram_reels_at: stringSchema(0, 80) },
    ["video_draft_id"],
  ),
  tool(
    "studio_video_preflight",
    "Validate an owned video source and configured targets without scheduling it.",
    { video_draft_id: integerSchema(1) },
    ["video_draft_id"],
  ),
  tool("studio_video_publish", "Queue all configured video targets for immediate publication.", { video_draft_id: integerSchema(1) }, [
    "video_draft_id",
  ]),
  tool(
    "studio_video_retry",
    "Retry one failed video target.",
    { video_draft_id: integerSchema(1), target: enumSchema(["youtube_shorts", "instagram_reels"]) },
    ["video_draft_id", "target"],
  ),
  tool(
    "studio_video_remove_target",
    "Remove one editable video target.",
    { video_draft_id: integerSchema(1), target: enumSchema(["youtube_shorts", "instagram_reels"]) },
    ["video_draft_id", "target"],
  ),
  tool("studio_video_cancel", "Cancel an owned video publication.", { video_draft_id: integerSchema(1) }, ["video_draft_id"]),
  tool("studio_analytics_dashboard", "Read an analytics dashboard section for the authenticated Studio.", {
    section: enumSchema(["overview", "posts", "video"]),
    days: { type: "integer", enum: [1, 7, 30] },
    locale: enumSchema(["ru", "en"]),
  }),
  tool("studio_analytics_post_archive", "Read a page of post analytics archive.", {
    offset: integerSchema(0, 10_000),
    locale: enumSchema(["ru", "en"]),
  }),
  tool(
    "studio_analytics_post_metrics",
    "Read analytics for one published post.",
    { post_id: integerSchema(1), locale: enumSchema(["ru", "en"]) },
    ["post_id"],
  ),
  tool("studio_analytics_video_archive", "Read a page of video analytics archive.", {
    offset: integerSchema(0, 10_000),
    locale: enumSchema(["ru", "en"]),
  }),
  tool(
    "studio_analytics_video_metrics",
    "Read analytics for one video draft.",
    { video_draft_id: integerSchema(1), locale: enumSchema(["ru", "en"]) },
    ["video_draft_id"],
  ),
  tool("studio_analytics_audience", "Read the creator audience analysis.", { locale: enumSchema(["ru", "en"]) }),
];

type JsonObject = Record<string, unknown>;

/** MCP is an adapter: all Studio commands delegate to the same application services as Telegram. */
export async function mcpResponse(
  backendDb: BackendDb,
  config: BackendConfig,
  body: unknown,
  clientKey: string,
  actorId: number | null,
): Promise<Record<string, unknown>> {
  if (!body || typeof body !== "object" || Array.isArray(body)) return rpcError(null, -32600, "Invalid request");
  const request = body as JsonObject;
  const id = request.id ?? null;
  if (request.method === "initialize")
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "alexgetman-studio-mcp", version: "2.1.0" },
      },
    };
  if (request.method === "tools/list")
    return { jsonrpc: "2.0", id, result: { tools: actorId ? [...publicTools, ...studioTools] : publicTools } };
  if (request.method !== "tools/call") return { jsonrpc: "2.0", id, result: {} };
  const params = object(request.params);
  const name = typeof params.name === "string" ? params.name : "";
  const args = object(params.arguments);
  try {
    if (name === "submit_feedback") return success(id, submitFeedback(backendDb, args, clientKey));
    if (!actorId) return rpcError(id, -32001, "Studio MCP authorization is required");
    return success(id, await runStudioTool(backendDb, config, actorId, name, args));
  } catch (error) {
    if (error instanceof McpToolError) return rpcError(id, error.code, error.message);
    return rpcError(id, -32602, error instanceof Error ? error.message : String(error));
  }
}

async function runStudioTool(
  backendDb: BackendDb,
  config: BackendConfig,
  actorId: number,
  name: string,
  args: JsonObject,
): Promise<unknown> {
  const studio: StudioServices = studioServices(backendDb, config);
  let result: unknown;
  let ref: string | null = null;
  switch (name) {
    case "studio_capabilities":
      return studio.capabilities.report();
    case "studio_queue":
      return studio.queue.snapshot(actorId);
    case "studio_notifications":
      return studio.notifications.inbox(actorId, optionalInteger(args.limit, 50, 1, 100));
    case "studio_media_list":
      return studio.posts.mediaAssets(actorId, optionalInteger(args.limit, 50, 1, 100));
    case "studio_acknowledge_notification":
      result = { acknowledged: studio.notifications.acknowledge(actorId, integer(args.id, "id")) };
      break;
    case "studio_post_create": {
      const textEn = optionalText(args.text_en, 20_000);
      const draftId = studio.posts.create(actorId, {
        text: text(args.text, "text", 1, 20_000),
        ...(textEn === undefined ? {} : { textEn }),
        entities: [],
        media: [],
      });
      result = { draft_id: draftId };
      ref = `draft:${draftId}`;
      break;
    }
    case "studio_post_get": {
      const draftId = integer(args.draft_id, "draft_id");
      return studio.posts.details(actorId, draftId);
    }
    case "studio_post_attach_media": {
      const draftId = integer(args.draft_id, "draft_id");
      const locale = enumValue(args.locale, "locale", ["ru", "en"] as const);
      const assetIds = integerArray(args.asset_ids, "asset_ids", 1, 10);
      studio.posts.attachMediaAssets(actorId, draftId, locale, assetIds, Boolean(args.replace));
      result = { draft_id: draftId, locale, asset_ids: assetIds, attached: true, replace: Boolean(args.replace) };
      ref = `draft:${draftId}`;
      break;
    }
    case "studio_post_preview":
      return studio.posts.preview(actorId, integer(args.draft_id, "draft_id"));
    case "studio_post_edit": {
      const draftId = integer(args.draft_id, "draft_id");
      const locale = enumValue(args.locale, "locale", ["ru", "en"] as const);
      studio.posts.editContent(actorId, draftId, { locale, text: text(args.text, "text", 0, 20_000), entities: [], media: [] });
      result = { draft_id: draftId, updated: true };
      ref = `draft:${draftId}`;
      break;
    }
    case "studio_post_toggle_target": {
      const draftId = integer(args.draft_id, "draft_id");
      studio.posts.toggleTarget(actorId, draftId, text(args.target, "target", 1, 120));
      result = { draft_id: draftId, updated: true };
      ref = `draft:${draftId}`;
      break;
    }
    case "studio_post_publish": {
      const draftId = integer(args.draft_id, "draft_id");
      const postId = studio.posts.publishNow(actorId, draftId);
      result = { draft_id: draftId, post_id: postId, queued: true };
      ref = `post:${postId}`;
      break;
    }
    case "studio_post_schedule": {
      const draftId = integer(args.draft_id, "draft_id");
      const ruAt = optionalDate(args.ru_at, "ru_at");
      const enAt = optionalDate(args.en_at, "en_at");
      if (!ruAt && !enAt) throw new Error("ru_at or en_at is required");
      const postId = studio.posts.schedule(actorId, draftId, { ruAt, enAt });
      result = { draft_id: draftId, post_id: postId, scheduled: true };
      ref = `post:${postId}`;
      break;
    }
    case "studio_post_cancel": {
      const draftId = integer(args.draft_id, "draft_id");
      studio.posts.cancel(actorId, draftId);
      result = { draft_id: draftId, cancelled: true };
      ref = `draft:${draftId}`;
      break;
    }
    case "studio_video_create": {
      const mediaAssetKey = assetKey(args.asset_key);
      const videoDraftId = studio.videos.create(actorId, mediaAssetKey);
      result = { video_draft_id: videoDraftId };
      ref = `video:${videoDraftId}`;
      break;
    }
    case "studio_video_get":
      return studio.videos.details(actorId, integer(args.video_draft_id, "video_draft_id"));
    case "studio_video_rename": {
      const videoDraftId = integer(args.video_draft_id, "video_draft_id");
      studio.videos.rename(actorId, videoDraftId, text(args.label, "label", 1, 500));
      result = { video_draft_id: videoDraftId, updated: true };
      ref = `video:${videoDraftId}`;
      break;
    }
    case "studio_video_replace_targets": {
      const videoDraftId = integer(args.video_draft_id, "video_draft_id");
      studio.videos.replaceTargets(actorId, videoDraftId, videoTargets(args.targets));
      result = { video_draft_id: videoDraftId, updated: true };
      ref = `video:${videoDraftId}`;
      break;
    }
    case "studio_video_update_metadata": {
      const videoDraftId = integer(args.video_draft_id, "video_draft_id");
      const target = videoTarget(args.target);
      studio.videos.updateMetadata(actorId, videoDraftId, target, videoMetadata(target, args.metadata));
      result = { video_draft_id: videoDraftId, target, updated: true };
      ref = `video:${videoDraftId}`;
      break;
    }
    case "studio_video_schedule": {
      const videoDraftId = integer(args.video_draft_id, "video_draft_id");
      const youtube = optionalDate(args.youtube_shorts_at, "youtube_shorts_at");
      const instagram = optionalDate(args.instagram_reels_at, "instagram_reels_at");
      if (!youtube && !instagram) throw new Error("youtube_shorts_at or instagram_reels_at is required");
      const technical = await studio.videos.schedule(actorId, videoDraftId, {
        ...(youtube ? { youtube_shorts: youtube } : {}),
        ...(instagram ? { instagram_reels: instagram } : {}),
      });
      result = { video_draft_id: videoDraftId, scheduled: true, technical };
      ref = `video:${videoDraftId}`;
      break;
    }
    case "studio_video_preflight":
      return studio.videos.preflight(actorId, integer(args.video_draft_id, "video_draft_id"));
    case "studio_video_publish": {
      const videoDraftId = integer(args.video_draft_id, "video_draft_id");
      const technical = await studio.videos.publishNow(actorId, videoDraftId);
      result = { video_draft_id: videoDraftId, queued: true, technical };
      ref = `video:${videoDraftId}`;
      break;
    }
    case "studio_video_retry": {
      const videoDraftId = integer(args.video_draft_id, "video_draft_id");
      const target = videoTarget(args.target);
      studio.videos.retry(actorId, videoDraftId, target);
      result = { video_draft_id: videoDraftId, target, retried: true };
      ref = `video:${videoDraftId}`;
      break;
    }
    case "studio_video_remove_target": {
      const videoDraftId = integer(args.video_draft_id, "video_draft_id");
      const target = videoTarget(args.target);
      result = { video_draft_id: videoDraftId, target, ...studio.videos.removeTarget(actorId, videoDraftId, target) };
      ref = `video:${videoDraftId}`;
      break;
    }
    case "studio_video_cancel": {
      const videoDraftId = integer(args.video_draft_id, "video_draft_id");
      studio.videos.cancel(actorId, videoDraftId);
      result = { video_draft_id: videoDraftId, cancelled: true };
      ref = `video:${videoDraftId}`;
      break;
    }
    case "studio_analytics_dashboard": {
      const section = enumValue(args.section ?? "overview", "section", ["overview", "posts", "video"] as const);
      const days = enumValue(args.days ?? 7, "days", [1, 7, 30] as const);
      const locale = enumValue(args.locale ?? "ru", "locale", ["ru", "en"] as const);
      return studio.analytics.dashboard(section, days, locale);
    }
    case "studio_analytics_post_archive":
      return studio.analytics.postArchive(
        optionalInteger(args.offset, 0, 0, 10_000),
        enumValue(args.locale ?? "ru", "locale", ["ru", "en"] as const),
      );
    case "studio_analytics_post_metrics":
      return studio.analytics.postMetrics(
        integer(args.post_id, "post_id"),
        enumValue(args.locale ?? "ru", "locale", ["ru", "en"] as const),
      );
    case "studio_analytics_video_archive":
      return studio.analytics.videoArchive(
        optionalInteger(args.offset, 0, 0, 10_000),
        enumValue(args.locale ?? "ru", "locale", ["ru", "en"] as const),
      );
    case "studio_analytics_video_metrics":
      return studio.analytics.videoMetrics(
        integer(args.video_draft_id, "video_draft_id"),
        enumValue(args.locale ?? "ru", "locale", ["ru", "en"] as const),
      );
    case "studio_analytics_audience":
      return studio.analytics.audienceAnalysis(enumValue(args.locale ?? "ru", "locale", ["ru", "en"] as const));
    default:
      throw new Error(`Unknown Studio tool: ${name}`);
  }
  recordDomainEvent(backendDb, {
    ref,
    type: "studio.mcp.command",
    severity: "info",
    target: "mcp",
    message: `Studio MCP ${name} executed`,
    details: { actorId, tool: name },
  });
  return result;
}

function submitFeedback(backendDb: BackendDb, args: JsonObject, clientKey: string): string {
  const name = optionalText(args.name, 120) || "Anonymous Agent";
  const message = text(args.message, "message", 1, 2000);
  if (rateLimited(clientKey)) throw new McpToolError(-32000, "rate limit exceeded");
  recordDomainEvent(backendDb, {
    ref: "mcp:feedback",
    target: "mcp",
    type: "mcp.feedback.received",
    severity: "info",
    message: `MCP Feedback from ${name}: ${message}`,
  });
  return `Thank you, ${name}! Your feedback has been logged.`;
}

function success(id: unknown, value: unknown): Record<string, unknown> {
  return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(value) }] } };
}

function tool(name: string, description: string, properties: JsonObject = {}, required: string[] = []): JsonObject {
  return { name, description, inputSchema: { type: "object", properties, ...(required.length ? { required } : {}) } };
}

function stringSchema(minLength: number, maxLength: number): JsonObject {
  return { type: "string", minLength, maxLength };
}

function integerSchema(minimum: number, maximum?: number): JsonObject {
  return { type: "integer", minimum, ...(maximum ? { maximum } : {}) };
}

function enumSchema(values: readonly (string | number)[]): JsonObject {
  return { enum: values };
}

function object(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};
}

function text(value: unknown, name: string, minLength: number, maxLength: number): string {
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  const result = value.trim();
  if (result.length < minLength || result.length > maxLength) throw new Error(`${name} must contain ${minLength}–${maxLength} characters`);
  return result;
}

function optionalText(value: unknown, maxLength: number): string | undefined {
  if (value == null) return undefined;
  return text(value, "value", 0, maxLength);
}

function integer(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

function integerArray(value: unknown, name: string, min: number, max: number): number[] {
  if (!Array.isArray(value) || value.length < min || value.length > max)
    throw new McpToolError(-32602, `${name} must contain ${min}-${max} integers`);
  const result = value.map((item) => integer(item, name));
  return [...new Set(result)];
}

function optionalInteger(value: unknown, fallback: number, min: number, max: number): number {
  if (value == null) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new Error("limit must be an integer");
  const result = value;
  if (result < min || result > max) throw new Error(`limit must be ${min}–${max}`);
  return result;
}

function enumValue<T extends string | number>(value: unknown, name: string, values: readonly T[]): T {
  if (!values.includes(value as T)) throw new Error(`${name} is invalid`);
  return value as T;
}

function optionalDate(value: unknown, name: string): Date | null {
  if (value == null || value === "") return null;
  if (typeof value !== "string") throw new Error(`${name} must be an ISO date`);
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`${name} must be an ISO date`);
  return date;
}

function assetKey(value: unknown): string {
  const result = text(value, "asset_key", 1, 120);
  if (!/^[a-zA-Z0-9_-]+$/.test(result)) throw new Error("asset_key is invalid");
  return result;
}

function videoTarget(value: unknown): "youtube_shorts" | "instagram_reels" {
  return enumValue(value, "target", ["youtube_shorts", "instagram_reels"] as const);
}

function videoTargets(value: unknown): Array<"youtube_shorts" | "instagram_reels"> {
  if (!Array.isArray(value) || value.length === 0 || value.length > 2) throw new Error("targets must contain one or two video targets");
  const targets = value.map(videoTarget);
  if (new Set(targets).size !== targets.length) throw new Error("targets must not contain duplicates");
  return targets;
}

function videoMetadata(target: "youtube_shorts" | "instagram_reels", value: unknown) {
  const metadata = object(value);
  if (target === "youtube_shorts") {
    const tags = metadata.tags;
    if (!Array.isArray(tags) || tags.length > 30 || tags.some((tag) => typeof tag !== "string"))
      throw new Error("metadata.tags must be an array of up to 30 strings");
    return {
      title: text(metadata.title, "metadata.title", 1, 100),
      description: text(metadata.description, "metadata.description", 0, 5_000),
      tags: tags.map((tag) => text(tag, "metadata.tags", 1, 100)),
      ...(metadata.game_url == null ? {} : { gameUrl: text(metadata.game_url, "metadata.game_url", 1, 500) }),
    };
  }
  return { caption: text(metadata.caption, "metadata.caption", 1, 2_200) };
}

function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

class McpToolError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

function rateLimited(key: string): boolean {
  const cutoff = Date.now() - 3_600_000;
  const hits = (feedbackHits.get(key) ?? []).filter((value) => value >= cutoff);
  if (hits.length >= 5) {
    feedbackHits.set(key, hits);
    return true;
  }
  hits.push(Date.now());
  feedbackHits.set(key, hits);
  return false;
}
