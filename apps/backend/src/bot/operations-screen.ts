import { type Context, InlineKeyboard } from "grammy";
import type { BackendConfig } from "../foundation/config.js";
import {
  parseDeploymentPromoteAskCallback,
  parseDeploymentPromoteCallback,
  parseDeploymentRollbackAskCallback,
  parseDeploymentRollbackCallback,
  requestDeploymentPromote,
  requestDeploymentRollback,
} from "../foundation/deployment.js";

/** Operations callbacks are deliberately outside content/post screens.
 * Every deploy action is ask -> confirm -> progress -> result, all as edits
 * to the same message, so a tap never looks like it silently did nothing. */
export async function handleOperationsCallback(ctx: Context, config: BackendConfig): Promise<boolean> {
  const data = ctx.callbackQuery?.data ?? "";

  const rollbackAsk = parseDeploymentRollbackAskCallback(data);
  if (rollbackAsk) return askConfirmation(ctx, "rollback", rollbackAsk.target, rollbackAsk.revision);

  const promoteAsk = parseDeploymentPromoteAskCallback(data);
  if (promoteAsk) return askConfirmation(ctx, "promote", promoteAsk.target, promoteAsk.revision);

  if (data === "deploy_cancel") {
    await ctx.answerCallbackQuery({ text: "Cancelled" });
    await ctx.editMessageText("🚫 Cancelled. No change was made.", { reply_markup: new InlineKeyboard() });
    return true;
  }

  const rollback = parseDeploymentRollbackCallback(data);
  if (rollback) {
    await runDeployAction(ctx, `⏳ Rolling back ${rollback.target}…`, () =>
      requestDeploymentRollback(config, rollback.target, rollback.revision),
    );
    return true;
  }

  const promote = parseDeploymentPromoteCallback(data);
  if (promote) {
    await runDeployAction(ctx, `⏳ Deploying ${promote.target} (${promote.revision.slice(0, 12)})…`, () =>
      requestDeploymentPromote(config, promote.target, promote.revision),
    );
    return true;
  }

  return false;
}

async function askConfirmation(ctx: Context, action: "rollback" | "promote", target: string, revision: string): Promise<boolean> {
  await ctx.answerCallbackQuery();
  const question =
    action === "rollback" ? `Roll ${target} back to the previous release?` : `Deploy ${revision.slice(0, 12)} to ${target} now?`;
  const confirmData = action === "rollback" ? `deploy_rollback:${target}:${revision}` : `deploy_promote:${target}:${revision}`;
  const original = ctx.callbackQuery?.message && "text" in ctx.callbackQuery.message ? ctx.callbackQuery.message.text : undefined;
  await ctx.editMessageText(`${original ? `${original}\n\n` : ""}⚠️ ${question}`, {
    reply_markup: new InlineKeyboard().text("✅ Yes", confirmData).text("❌ Cancel", "deploy_cancel"),
  });
  return true;
}

async function runDeployAction(
  ctx: Context,
  progressText: string,
  action: () => Promise<{ ok: true; release: string; currentRevision: string } | { ok: false; message: string }>,
): Promise<void> {
  await ctx.answerCallbackQuery();
  await ctx.editMessageText(progressText, { reply_markup: new InlineKeyboard() });
  // Deliberately not awaited: the bot polls updates one at a time, and this
  // request alone can take up to ~150s (agent healthcheck plus image pull).
  // Awaiting it here would freeze every chat's buttons and messages until it
  // resolves. Let it run in the background and edit this message once it's done.
  void action()
    .then((result) => finishDeployAction(ctx, result))
    .catch((error) => finishDeployAction(ctx, { ok: false, message: error instanceof Error ? error.message : String(error) }));
}

async function finishDeployAction(
  ctx: Context,
  result: { ok: true; release: string; currentRevision: string } | { ok: false; message: string },
): Promise<void> {
  const finalText = result.ok ? `✅ Done: now running ${result.currentRevision.slice(0, 12)}.` : `❌ Failed: ${result.message}`;
  try {
    await ctx.editMessageText(finalText);
  } catch {
    await ctx.reply(finalText);
  }
}
