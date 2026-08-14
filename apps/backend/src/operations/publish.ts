import { isStoryTarget, targetLocale } from "../botTargets.js";
import { type BackendDb, unsafeDb } from "../db/client.js";
import type { BackendConfig } from "../foundation/config.js";
import { createStudioServices } from "../studio/services/index.js";

type PublishTextInput = {
  locale: "ru" | "en";
  targets: string[];
  text: string;
};

/** Creates the complete operator-authored text publication in one database
 * transaction. Interactive editors keep their draft workflow; Operations gets
 * the finished action it asked for instead of replaying every editor click. */
export function publishText(backendDb: BackendDb, config: BackendConfig, input: PublishTextInput) {
  const targets = [...new Set(input.targets)];
  if (!targets.length) throw new Error("publish needs at least one target");
  for (const target of targets) {
    if (isStoryTarget(target)) throw new Error(`publish does not create Story media; use the draft editor for ${target}`);
    const locale = targetLocale(target);
    if (!locale) throw new Error(`unknown publication target: ${target}`);
    if (locale !== input.locale) throw new Error(`${target} is ${locale}, not ${input.locale}`);
  }
  const actorId = config.MCP_STUDIO_ACTOR_ID ?? config.STUDIO_ACTOR_IDS[0] ?? config.CONTROLLER_ADMIN_IDS[0];
  if (!actorId) throw new Error("publish needs a configured Studio actor");
  const posts = createStudioServices(backendDb, config).posts;
  return unsafeDb(backendDb)
    .sqlite.transaction(() => {
      const draftId = posts.create(
        actorId,
        {
          text: input.text,
          textEn: input.text,
          textEnApproved: input.text,
          entities: [],
          media: [],
        },
        { targets },
      );
      const postId = posts.publish(actorId, draftId);
      return {
        ok: true,
        draft_id: draftId,
        post_id: postId,
        ref: `post:${postId}`,
        targets,
        queued: true,
      };
    })
    .immediate();
}
