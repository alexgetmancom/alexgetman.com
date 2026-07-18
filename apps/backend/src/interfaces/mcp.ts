import * as z from "zod";
import type { BackendDb } from "../db/client.js";
import { recordDomainEvent } from "../domain/events.js";
import type { BackendConfig } from "../foundation/config.js";
import { type StudioServices, studioServices } from "../studio/services/index.js";

const feedbackHits = new Map<string, number[]>();

// --- Shared zod building blocks -------------------------------------------------

const trimmed = (min: number, max: number) => z.string().trim().min(min).max(max);
const positiveInt = z.number().int().min(1);
const localeSchema = z.enum(["ru", "en"]);
const videoTargetSchema = z.enum(["youtube_shorts", "instagram_reels"]);

/** Plain shape for an optional ISO-date string field, for the client-facing schema.
 * The parsing schema below adds a `.transform()` z.toJSONSchema can't represent,
 * so tools with date fields keep this shape separately as their `list` schema. */
function isoDateShape(maxLength: number) {
  return z.string().max(maxLength).optional();
}

/** Empty string or absent both mean "no value"; otherwise must be a parseable ISO date. */
function isoDateOrNull(maxLength: number) {
  return isoDateShape(maxLength).transform((value, ctx) => {
    if (value == null || value === "") return null;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      ctx.addIssue({ code: "custom", message: "must be an ISO date" });
      return z.NEVER;
    }
    return date;
  });
}

/** Plain shape for the client-facing schema; see isoDateShape. */
function intArrayShape(min: number, max: number) {
  return z.array(positiveInt).min(min).max(max);
}

function uniqueIntArray(min: number, max: number) {
  return intArrayShape(min, max).transform((values) => [...new Set(values)]);
}

const youtubeMetadataSchema = z.object({
  title: trimmed(1, 100),
  description: trimmed(0, 5_000),
  tags: z.array(trimmed(1, 100)).max(30),
  game_url: trimmed(1, 500).optional(),
});
const instagramMetadataSchema = z.object({ caption: trimmed(1, 2_200) });

/** JSON Schema for an MCP tool listing, stripped of the document-level $schema key.
 * Uses `def.list` when a tool's real schema has a transform (dates, dedup, metadata
 * shaping) that z.toJSONSchema can't represent. */
function jsonSchema(def: { schema: z.ZodType; list?: z.ZodType }): JsonObject {
  const { $schema: _dropped, ...rest } = z.toJSONSchema(def.list ?? def.schema) as JsonObject & { $schema?: unknown };
  return rest;
}

function parseArgs<T>(schema: z.ZodType<T>, args: unknown): T {
  const result = schema.safeParse(args);
  if (!result.success) throw new Error(result.error.issues[0]?.message ?? "invalid arguments");
  return result.data;
}

// --- Tool catalog: one zod schema per tool is both its validator and its client-facing schema ---

const feedbackToolDef = {
  description: "Send feedback or a bug report to Alex Getman.",
  schema: z.object({ name: trimmed(0, 120).optional(), message: trimmed(1, 2_000) }),
};

const studioToolDefs = {
  studio_capabilities: {
    description: "Read enabled Studio modules and sanitized platform readiness before selecting a command.",
    schema: z.object({}),
  },
  studio_queue: { description: "Read the authenticated owner's upcoming work, drafts and failures.", schema: z.object({}) },
  studio_post_list: {
    description: "List the authenticated owner's post drafts.",
    schema: z.object({ limit: positiveInt.max(100).optional() }),
  },
  studio_notifications: {
    description: "Read the authenticated owner's durable Studio notification inbox.",
    schema: z.object({ limit: positiveInt.max(100).optional() }),
  },
  studio_notification_settings: {
    description: "Read the authenticated owner's Studio notification policy.",
    schema: z.object({}),
  },
  studio_notification_settings_update: {
    description: "Update notification policy. These settings apply to every connected interface; Telegram is only one delivery adapter.",
    schema: z.object({
      reminders_enabled: z.boolean().optional(),
      reminder_minutes: z.number().int().min(1).max(60).optional(),
      completion_enabled: z.boolean().optional(),
    }),
  },
  studio_media_list: {
    description: "List the authenticated owner's reusable Studio media assets.",
    schema: z.object({ limit: positiveInt.max(100).optional() }),
  },
  studio_acknowledge_notification: {
    description: "Mark one visible Studio notification as read.",
    schema: z.object({ id: positiveInt }),
  },
  studio_post_create: {
    description: "Create a text-post draft for the authenticated owner.",
    schema: z.object({ text: trimmed(1, 20_000), text_en: trimmed(0, 20_000).optional() }),
  },
  studio_post_get: { description: "Read one owned post draft.", schema: z.object({ draft_id: positiveInt }) },
  studio_post_validate: {
    description: "Validate one owned post draft before publishing.",
    schema: z.object({ draft_id: positiveInt }),
  },
  studio_post_status: {
    description: "Read queue and target status for one owned post draft.",
    schema: z.object({ draft_id: positiveInt }),
  },
  studio_post_history: {
    description: "Read durable event history for one owned post draft.",
    schema: z.object({ draft_id: positiveInt, limit: positiveInt.max(100).optional() }),
  },
  studio_post_attach_media: {
    description: "Attach already uploaded Studio media assets to an owned post locale. Upload files through POST /api/studio/media first.",
    schema: z.object({
      draft_id: positiveInt,
      locale: localeSchema,
      asset_ids: uniqueIntArray(1, 10),
      replace: z.boolean().optional(),
    }),
    list: z.object({ draft_id: positiveInt, locale: localeSchema, asset_ids: intArrayShape(1, 10), replace: z.boolean().optional() }),
  },
  studio_post_remove_media: {
    description: "Remove selected Studio media assets from one owned post locale.",
    schema: z.object({ draft_id: positiveInt, locale: localeSchema, asset_ids: uniqueIntArray(1, 10) }),
    list: z.object({ draft_id: positiveInt, locale: localeSchema, asset_ids: intArrayShape(1, 10) }),
  },
  studio_post_preview: {
    description: "Read a transport-neutral preview of one owned post draft.",
    schema: z.object({ draft_id: positiveInt }),
  },
  studio_post_edit: {
    description: "Edit text on one owned post draft.",
    schema: z.object({ draft_id: positiveInt, locale: localeSchema, text: trimmed(0, 20_000) }),
  },
  studio_post_toggle_target: {
    description: "Toggle one configured target on an owned post draft.",
    schema: z.object({ draft_id: positiveInt, target: trimmed(1, 120) }),
  },
  studio_post_publish: {
    description: "Queue an owned post draft for immediate publication.",
    schema: z.object({ draft_id: positiveInt }),
  },
  studio_post_schedule: {
    description: "Schedule an owned post draft. ISO dates are optional per locale.",
    schema: z
      .object({ draft_id: positiveInt, ru_at: isoDateOrNull(80), en_at: isoDateOrNull(80) })
      .refine((value) => value.ru_at || value.en_at, { message: "ru_at or en_at is required" }),
    list: z.object({ draft_id: positiveInt, ru_at: isoDateShape(80), en_at: isoDateShape(80) }),
  },
  studio_post_cancel: {
    description: "Cancel an owned post draft and its remaining work.",
    schema: z.object({ draft_id: positiveInt }),
  },
  studio_video_create: {
    description: "Create an owned video draft from an already-uploaded Studio video asset.",
    schema: z.object({ asset_id: positiveInt }),
  },
  studio_video_list: {
    description: "List the authenticated owner's video drafts.",
    schema: z.object({ limit: positiveInt.max(100).optional() }),
  },
  studio_video_get: {
    description: "Read an owned video draft and its targets.",
    schema: z.object({ video_draft_id: positiveInt }),
  },
  studio_video_preview: {
    description: "Read an owned video draft preview and target metadata.",
    schema: z.object({ video_draft_id: positiveInt }),
  },
  studio_video_status: { description: "Read owned video targets and durable jobs.", schema: z.object({ video_draft_id: positiveInt }) },
  studio_video_history: {
    description: "Read durable event history for one owned video draft.",
    schema: z.object({ video_draft_id: positiveInt, limit: positiveInt.max(100).optional() }),
  },
  studio_video_rename: {
    description: "Rename an owned video draft.",
    schema: z.object({ video_draft_id: positiveInt, label: trimmed(1, 500) }),
  },
  studio_video_replace_targets: {
    description: "Replace editable video publication targets.",
    schema: z.object({
      video_draft_id: positiveInt,
      targets: z
        .array(videoTargetSchema)
        .min(1)
        .max(2)
        .refine((values) => new Set(values).size === values.length, { message: "targets must not contain duplicates" }),
    }),
  },
  studio_video_update_metadata: {
    description: "Set target metadata. YouTube requires title, description and tags; Instagram requires caption.",
    schema: z
      .object({ video_draft_id: positiveInt, target: videoTargetSchema, metadata: z.record(z.string(), z.unknown()) })
      .transform((value, ctx) => {
        const parsed =
          value.target === "youtube_shorts"
            ? youtubeMetadataSchema.safeParse(value.metadata)
            : instagramMetadataSchema.safeParse(value.metadata);
        if (!parsed.success) {
          ctx.addIssue({ code: "custom", message: parsed.error.issues[0]?.message ?? "metadata is invalid" });
          return z.NEVER;
        }
        const metadata =
          "game_url" in parsed.data
            ? { title: parsed.data.title, description: parsed.data.description, tags: parsed.data.tags, gameUrl: parsed.data.game_url }
            : parsed.data;
        return { videoDraftId: value.video_draft_id, target: value.target, metadata };
      }),
    list: z.object({ video_draft_id: positiveInt, target: videoTargetSchema, metadata: z.record(z.string(), z.unknown()) }),
  },
  studio_video_schedule: {
    description: "Schedule one or both configured video targets at future ISO datetimes.",
    schema: z
      .object({ video_draft_id: positiveInt, youtube_shorts_at: isoDateOrNull(80), instagram_reels_at: isoDateOrNull(80) })
      .refine((value) => value.youtube_shorts_at || value.instagram_reels_at, {
        message: "youtube_shorts_at or instagram_reels_at is required",
      }),
    list: z.object({ video_draft_id: positiveInt, youtube_shorts_at: isoDateShape(80), instagram_reels_at: isoDateShape(80) }),
  },
  studio_video_preflight: {
    description: "Validate an owned video source and configured targets without scheduling it.",
    schema: z.object({ video_draft_id: positiveInt }),
  },
  studio_video_publish: {
    description: "Queue all configured video targets for immediate publication.",
    schema: z.object({ video_draft_id: positiveInt }),
  },
  studio_video_retry: {
    description: "Retry one failed video target.",
    schema: z.object({ video_draft_id: positiveInt, target: videoTargetSchema }),
  },
  studio_video_remove_target: {
    description: "Remove one editable video target.",
    schema: z.object({ video_draft_id: positiveInt, target: videoTargetSchema }),
  },
  studio_video_cancel: { description: "Cancel an owned video publication.", schema: z.object({ video_draft_id: positiveInt }) },
  studio_analytics_dashboard: {
    description: "Read an analytics dashboard section for the authenticated Studio.",
    schema: z.object({
      section: z.enum(["overview", "audience", "posts", "video"]).optional(),
      days: z.union([z.literal(1), z.literal(7), z.literal(30)]).optional(),
      locale: localeSchema.optional(),
    }),
  },
  studio_analytics_post_archive: {
    description: "Read a page of post analytics archive.",
    schema: z.object({ offset: z.number().int().min(0).max(10_000).optional(), locale: localeSchema.optional() }),
  },
  studio_analytics_post_metrics: {
    description: "Read analytics for one published post.",
    schema: z.object({ post_id: positiveInt, locale: localeSchema.optional() }),
  },
  studio_analytics_video_archive: {
    description: "Read a page of video analytics archive.",
    schema: z.object({ offset: z.number().int().min(0).max(10_000).optional(), locale: localeSchema.optional() }),
  },
  studio_analytics_video_metrics: {
    description: "Read analytics for one video draft.",
    schema: z.object({ video_draft_id: positiveInt, locale: localeSchema.optional() }),
  },
  studio_analytics_audience: {
    description: "Read the creator audience analysis.",
    schema: z.object({ locale: localeSchema.optional() }),
  },
} as const;

const publicTools = [{ name: "submit_feedback", description: feedbackToolDef.description, inputSchema: jsonSchema(feedbackToolDef) }];
const studioTools = Object.entries(studioToolDefs).map(([name, def]) => ({
  name,
  description: def.description,
  inputSchema: jsonSchema(def),
}));

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
  const def = (studioToolDefs as Record<string, { schema: z.ZodType }>)[name];
  if (!def) throw new Error(`Unknown Studio tool: ${name}`);
  let result: unknown;
  let ref: string | null = null;
  switch (name) {
    case "studio_capabilities":
      return studio.capabilities.report();
    case "studio_queue":
      return studio.queue.snapshot(actorId);
    case "studio_post_list": {
      const input = parseArgs(def.schema, args) as { limit?: number };
      return studio.posts.list(actorId, input.limit ?? 50);
    }
    case "studio_notifications": {
      const input = parseArgs(def.schema, args) as { limit?: number };
      return studio.notifications.inbox(actorId, input.limit ?? 50);
    }
    case "studio_notification_settings":
      return studio.settings.notifications(actorId);
    case "studio_notification_settings_update": {
      const input = parseArgs(def.schema, args) as {
        reminders_enabled?: boolean;
        reminder_minutes?: number;
        completion_enabled?: boolean;
      };
      return studio.settings.setNotifications(actorId, {
        ...(input.reminders_enabled === undefined ? {} : { remindersEnabled: input.reminders_enabled }),
        ...(input.reminder_minutes === undefined ? {} : { reminderMinutes: input.reminder_minutes }),
        ...(input.completion_enabled === undefined ? {} : { completionEnabled: input.completion_enabled }),
      });
    }
    case "studio_media_list": {
      const input = parseArgs(def.schema, args) as { limit?: number };
      return studio.posts.mediaAssets(actorId, input.limit ?? 50);
    }
    case "studio_acknowledge_notification": {
      const input = parseArgs(def.schema, args) as { id: number };
      result = { acknowledged: studio.notifications.acknowledge(actorId, input.id) };
      break;
    }
    case "studio_post_create": {
      const input = parseArgs(def.schema, args) as { text: string; text_en?: string };
      const draftId = studio.publications.create(actorId, {
        kind: "post",
        message: { text: input.text, ...(input.text_en === undefined ? {} : { textEn: input.text_en }), entities: [], media: [] },
      }).id;
      result = { draft_id: draftId };
      ref = `draft:${draftId}`;
      break;
    }
    case "studio_post_get": {
      const input = parseArgs(def.schema, args) as { draft_id: number };
      return studio.posts.get(actorId, input.draft_id);
    }
    case "studio_post_validate": {
      const input = parseArgs(def.schema, args) as { draft_id: number };
      return studio.posts.validate(actorId, input.draft_id);
    }
    case "studio_post_status": {
      const input = parseArgs(def.schema, args) as { draft_id: number };
      return studio.posts.status(actorId, input.draft_id);
    }
    case "studio_post_history": {
      const input = parseArgs(def.schema, args) as { draft_id: number; limit?: number };
      return studio.posts.history(actorId, input.draft_id, input.limit ?? 50);
    }
    case "studio_post_attach_media": {
      const input = parseArgs(def.schema, args) as { draft_id: number; locale: "ru" | "en"; asset_ids: number[]; replace?: boolean };
      studio.posts.attachMediaAssets(actorId, input.draft_id, input.locale, input.asset_ids, Boolean(input.replace));
      result = {
        draft_id: input.draft_id,
        locale: input.locale,
        asset_ids: input.asset_ids,
        attached: true,
        replace: Boolean(input.replace),
      };
      ref = `draft:${input.draft_id}`;
      break;
    }
    case "studio_post_remove_media": {
      const input = parseArgs(def.schema, args) as { draft_id: number; locale: "ru" | "en"; asset_ids: number[] };
      studio.posts.removeMedia(actorId, input.draft_id, input.locale, input.asset_ids);
      result = { draft_id: input.draft_id, locale: input.locale, asset_ids: input.asset_ids, removed: true };
      ref = `draft:${input.draft_id}`;
      break;
    }
    case "studio_post_preview": {
      const input = parseArgs(def.schema, args) as { draft_id: number };
      return studio.posts.preview(actorId, input.draft_id);
    }
    case "studio_post_edit": {
      const input = parseArgs(def.schema, args) as { draft_id: number; locale: "ru" | "en"; text: string };
      studio.posts.edit(actorId, input.draft_id, { locale: input.locale, text: input.text, entities: [], media: [] });
      result = { draft_id: input.draft_id, updated: true };
      ref = `draft:${input.draft_id}`;
      break;
    }
    case "studio_post_toggle_target": {
      const input = parseArgs(def.schema, args) as { draft_id: number; target: string };
      studio.posts.toggleTarget(actorId, input.draft_id, input.target);
      result = { draft_id: input.draft_id, updated: true };
      ref = `draft:${input.draft_id}`;
      break;
    }
    case "studio_post_publish": {
      const input = parseArgs(def.schema, args) as { draft_id: number };
      const postId = studio.posts.publish(actorId, input.draft_id);
      result = { draft_id: input.draft_id, post_id: postId, queued: true };
      ref = `post:${postId}`;
      break;
    }
    case "studio_post_schedule": {
      const input = parseArgs(def.schema, args) as { draft_id: number; ru_at: Date | null; en_at: Date | null };
      const postId = studio.posts.schedule(actorId, input.draft_id, { ruAt: input.ru_at, enAt: input.en_at });
      result = { draft_id: input.draft_id, post_id: postId, scheduled: true };
      ref = `post:${postId}`;
      break;
    }
    case "studio_post_cancel": {
      const input = parseArgs(def.schema, args) as { draft_id: number };
      studio.posts.cancel(actorId, input.draft_id);
      result = { draft_id: input.draft_id, cancelled: true };
      ref = `draft:${input.draft_id}`;
      break;
    }
    case "studio_video_create": {
      const input = parseArgs(def.schema, args) as { asset_id: number };
      const videoDraftId = studio.publications.create(actorId, { kind: "video", studioMediaAssetId: input.asset_id }).id;
      result = { video_draft_id: videoDraftId };
      ref = `video:${videoDraftId}`;
      break;
    }
    case "studio_video_list": {
      const input = parseArgs(def.schema, args) as { limit?: number };
      return studio.videos.list(actorId, input.limit ?? 50);
    }
    case "studio_video_get": {
      const input = parseArgs(def.schema, args) as { video_draft_id: number };
      return studio.videos.get(actorId, input.video_draft_id);
    }
    case "studio_video_preview": {
      const input = parseArgs(def.schema, args) as { video_draft_id: number };
      return studio.videos.preview(actorId, input.video_draft_id);
    }
    case "studio_video_status": {
      const input = parseArgs(def.schema, args) as { video_draft_id: number };
      return studio.videos.status(actorId, input.video_draft_id);
    }
    case "studio_video_history": {
      const input = parseArgs(def.schema, args) as { video_draft_id: number; limit?: number };
      return studio.videos.history(actorId, input.video_draft_id, input.limit ?? 50);
    }
    case "studio_video_rename": {
      const input = parseArgs(def.schema, args) as { video_draft_id: number; label: string };
      studio.videos.rename(actorId, input.video_draft_id, input.label);
      result = { video_draft_id: input.video_draft_id, updated: true };
      ref = `video:${input.video_draft_id}`;
      break;
    }
    case "studio_video_replace_targets": {
      const input = parseArgs(def.schema, args) as { video_draft_id: number; targets: Array<"youtube_shorts" | "instagram_reels"> };
      studio.videos.replaceTargets(actorId, input.video_draft_id, input.targets);
      result = { video_draft_id: input.video_draft_id, updated: true };
      ref = `video:${input.video_draft_id}`;
      break;
    }
    case "studio_video_update_metadata": {
      const input = parseArgs(def.schema, args) as {
        videoDraftId: number;
        target: "youtube_shorts" | "instagram_reels";
        metadata: Record<string, unknown>;
      };
      studio.videos.updateMetadata(actorId, input.videoDraftId, input.target, input.metadata as never);
      result = { video_draft_id: input.videoDraftId, target: input.target, updated: true };
      ref = `video:${input.videoDraftId}`;
      break;
    }
    case "studio_video_schedule": {
      const input = parseArgs(def.schema, args) as {
        video_draft_id: number;
        youtube_shorts_at: Date | null;
        instagram_reels_at: Date | null;
      };
      const technical = await studio.videos.schedule(actorId, input.video_draft_id, {
        ...(input.youtube_shorts_at ? { youtube_shorts: input.youtube_shorts_at } : {}),
        ...(input.instagram_reels_at ? { instagram_reels: input.instagram_reels_at } : {}),
      });
      result = { video_draft_id: input.video_draft_id, scheduled: true, technical };
      ref = `video:${input.video_draft_id}`;
      break;
    }
    case "studio_video_preflight": {
      const input = parseArgs(def.schema, args) as { video_draft_id: number };
      return studio.videos.validate(actorId, input.video_draft_id);
    }
    case "studio_video_publish": {
      const input = parseArgs(def.schema, args) as { video_draft_id: number };
      const technical = await studio.videos.publish(actorId, input.video_draft_id);
      result = { video_draft_id: input.video_draft_id, queued: true, technical };
      ref = `video:${input.video_draft_id}`;
      break;
    }
    case "studio_video_retry": {
      const input = parseArgs(def.schema, args) as { video_draft_id: number; target: "youtube_shorts" | "instagram_reels" };
      studio.videos.retry(actorId, input.video_draft_id, input.target);
      result = { video_draft_id: input.video_draft_id, target: input.target, retried: true };
      ref = `video:${input.video_draft_id}`;
      break;
    }
    case "studio_video_remove_target": {
      const input = parseArgs(def.schema, args) as { video_draft_id: number; target: "youtube_shorts" | "instagram_reels" };
      result = {
        video_draft_id: input.video_draft_id,
        target: input.target,
        ...studio.videos.removeTarget(actorId, input.video_draft_id, input.target),
      };
      ref = `video:${input.video_draft_id}`;
      break;
    }
    case "studio_video_cancel": {
      const input = parseArgs(def.schema, args) as { video_draft_id: number };
      result = { video_draft_id: input.video_draft_id, cancelled: true, ...(await studio.videos.cancel(actorId, input.video_draft_id)) };
      ref = `video:${input.video_draft_id}`;
      break;
    }
    case "studio_analytics_dashboard": {
      const input = parseArgs(def.schema, args) as {
        section?: "overview" | "audience" | "posts" | "video";
        days?: 1 | 7 | 30;
        locale?: "ru" | "en";
      };
      return studio.analytics.dashboard(input.section ?? "overview", input.days ?? 7, input.locale ?? "ru");
    }
    case "studio_analytics_post_archive": {
      const input = parseArgs(def.schema, args) as { offset?: number; locale?: "ru" | "en" };
      return studio.analytics.postArchive(input.offset ?? 0, input.locale ?? "ru");
    }
    case "studio_analytics_post_metrics": {
      const input = parseArgs(def.schema, args) as { post_id: number; locale?: "ru" | "en" };
      return studio.analytics.postMetrics(input.post_id, input.locale ?? "ru");
    }
    case "studio_analytics_video_archive": {
      const input = parseArgs(def.schema, args) as { offset?: number; locale?: "ru" | "en" };
      return studio.analytics.videoArchive(input.offset ?? 0, input.locale ?? "ru");
    }
    case "studio_analytics_video_metrics": {
      const input = parseArgs(def.schema, args) as { video_draft_id: number; locale?: "ru" | "en" };
      return studio.analytics.videoMetrics(input.video_draft_id, input.locale ?? "ru");
    }
    case "studio_analytics_audience": {
      const input = parseArgs(def.schema, args) as { locale?: "ru" | "en" };
      return studio.analytics.audienceAnalysis(input.locale ?? "ru");
    }
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
  const input = parseArgs(feedbackToolDef.schema, args);
  const name = input.name || "Anonymous Agent";
  if (rateLimited(clientKey)) throw new McpToolError(-32000, "rate limit exceeded");
  recordDomainEvent(backendDb, {
    ref: "mcp:feedback",
    target: "mcp",
    type: "mcp.feedback.received",
    severity: "info",
    message: `MCP Feedback from ${name}: ${input.message}`,
  });
  return `Thank you, ${name}! Your feedback has been logged.`;
}

function success(id: unknown, value: unknown): Record<string, unknown> {
  return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(value) }] } };
}

function object(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};
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
