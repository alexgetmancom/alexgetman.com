import type { Context } from "grammy";
import type { BackendConfig } from "../foundation/config.js";
import { parseDeploymentRollbackCallback, requestDeploymentRollback } from "../foundation/deployment.js";

/** Operations callbacks are deliberately outside content/post screens. */
export async function handleOperationsCallback(ctx: Context, config: BackendConfig): Promise<boolean> {
  const rollback = parseDeploymentRollbackCallback(ctx.callbackQuery?.data ?? "");
  if (!rollback) return false;
  const result = await requestDeploymentRollback(config, rollback.target, rollback.revision);
  await ctx.answerCallbackQuery({ text: "Rollback requested" });
  await ctx.reply(
    result.ok ? `Rollback complete: ${result.currentRevision.slice(0, 12)}.` : `Rollback was not performed: ${result.message}`,
  );
  return true;
}
