import type { Context } from "grammy";
import type { BackendConfig } from "../foundation/config.js";
import {
  parseDeploymentPromoteCallback,
  parseDeploymentRollbackCallback,
  requestDeploymentPromote,
  requestDeploymentRollback,
} from "../foundation/deployment.js";

/** Operations callbacks are deliberately outside content/post screens. */
export async function handleOperationsCallback(ctx: Context, config: BackendConfig): Promise<boolean> {
  const rollback = parseDeploymentRollbackCallback(ctx.callbackQuery?.data ?? "");
  if (rollback) {
    const result = await requestDeploymentRollback(config, rollback.target, rollback.revision);
    await ctx.answerCallbackQuery({ text: "Rollback requested" });
    await ctx.reply(
      result.ok ? `Rollback complete: ${result.currentRevision.slice(0, 12)}.` : `Rollback was not performed: ${result.message}`,
    );
    return true;
  }
  const promote = parseDeploymentPromoteCallback(ctx.callbackQuery?.data ?? "");
  if (promote) {
    const result = await requestDeploymentPromote(config, promote.target, promote.revision);
    await ctx.answerCallbackQuery({ text: "Deploy requested" });
    await ctx.reply(
      result.ok
        ? `Deployed to ${promote.target}: ${result.currentRevision.slice(0, 12)}.`
        : `Deploy to ${promote.target} was not performed: ${result.message}`,
    );
    return true;
  }
  return false;
}
