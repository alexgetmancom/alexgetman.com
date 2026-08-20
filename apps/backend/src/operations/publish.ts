import { publicationRef } from "../application/publication-ref.js";
import { isStoryTarget, targetLocale } from "../botTargets.js";
import { effectivePostTargets } from "../channels/registry.js";
import { type BackendDb, unsafeDb } from "../db/client.js";
import type { BackendConfig } from "../foundation/config.js";
import { primaryStudioActorId } from "../studio/access.js";
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
  // A target with no connected channel is dropped when the plan is built, and
  // this used to report `queued: true` for a publication that had nothing to
  // deliver — every target off, no jobs, an operator told it went out.
  const deliverable = effectivePostTargets(backendDb, Object.fromEntries(targets.map((target) => [target, true])));
  const unconnected = targets.filter((target) => !deliverable[target]);
  if (unconnected.length) throw new Error(`no connected channel for ${unconnected.join(", ")}; run \`channels\` to see what is connected`);
  const actorId = primaryStudioActorId(config);
  if (!actorId) throw new Error("publish needs a configured Studio actor");
  const posts = createStudioServices(backendDb, config).posts;
  return unsafeDb(backendDb)
    .sqlite.transaction(() => {
      // The text is in one language and goes to targets in that language.
      // Writing it into both used to mark the Russian original as the
      // *approved* English text — the strongest claim this system has — and an
      // English target then published it.
      const draftId = posts.create(
        actorId,
        {
          text: input.locale === "ru" ? input.text : "",
          ...(input.locale === "en" ? { textEn: input.text, textEnApproved: input.text } : {}),
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
        ref: publicationRef("post", postId),
        targets,
        queued: true,
      };
    })
    .immediate();
}
