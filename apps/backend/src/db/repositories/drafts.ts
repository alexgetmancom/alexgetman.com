import { desc, eq, inArray } from "drizzle-orm";
import type { Clock, DraftPatch, DraftRecord, DraftStore, NewDraft } from "../../application/ports.js";
import { drafts } from "../schema.js";
import type { BackendDatabase } from "../types.js";

const draftProjection = {
  id: drafts.id,
  actor_id: drafts.actorId,
  status: drafts.status,
  text_ru: drafts.textRu,
  text_en_machine: drafts.textEnMachine,
  text_en_approved: drafts.textEnApproved,
  targets_json: drafts.targetsJson,
  media_ru_json: drafts.mediaRuJson,
  media_en_json: drafts.mediaEnJson,
  channel_message_id: drafts.channelMessageId,
  scheduled_at: drafts.scheduledAt,
  scheduled_en_at: drafts.scheduledEnAt,
  post_id: drafts.postId,
  text_ru_entities_json: drafts.textRuEntitiesJson,
  text_en_entities_json: drafts.textEnEntitiesJson,
  threads_chain_approved: drafts.threadsChainApproved,
  story_publish_mode: drafts.storyPublishMode,
};

/** SQLite adapter for the application-level draft port. */
export function createDraftStore(db: BackendDatabase, clock: Clock): DraftStore {
  return {
    create(input: NewDraft): number {
      const now = clock.now().toISOString();
      const created = db
        .insert(drafts)
        .values({
          actorId: input.actorId,
          status: "needs_review",
          textRu: input.textRu,
          textEnMachine: input.textEnMachine,
          textEnApproved: input.textEnApproved,
          targetsJson: input.targetsJson,
          mediaRuJson: input.mediaRuJson,
          textRuEntitiesJson: input.textRuEntitiesJson,
          storyPublishMode: input.storyPublishMode,
          createdAt: now,
          updatedAt: now,
        })
        .returning({ id: drafts.id })
        .get();
      if (!created) throw new Error("draft insert did not return an id");
      return created.id;
    },

    get(id: number): DraftRecord | null {
      return db.select(draftProjection).from(drafts).where(eq(drafts.id, id)).get() ?? null;
    },

    list(actorIds: number[], limit: number): DraftRecord[] {
      return db
        .select(draftProjection)
        .from(drafts)
        .where(inArray(drafts.actorId, actorIds))
        .orderBy(desc(drafts.updatedAt))
        .limit(limit)
        .all();
    },

    update(id: number, patch: DraftPatch): void {
      db.update(drafts).set(patch).where(eq(drafts.id, id)).run();
    },
  };
}
