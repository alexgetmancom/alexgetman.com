import { type Context, InlineKeyboard } from "grammy";
import type { BackendDb } from "../db/client.js";
import { withActionLock } from "../foundation/action-lock.js";
import type { BackendConfig } from "../foundation/config.js";
import {
  deploymentMenuCallback,
  parseDeploymentMenuCallback,
  parseDeploymentPromoteAskCallback,
  parseDeploymentPromoteCallback,
  parseDeploymentRollbackAskCallback,
  parseDeploymentRollbackCallback,
  requestDeploymentPromote,
  requestDeploymentRollback,
} from "../foundation/deployment.js";
import { t } from "../foundation/i18n/index.js";
import type { StudioLocale } from "../foundation/locale.js";
import { botLocale } from "./i18n.js";

/** Operations callbacks are deliberately outside content/post screens.
 * Every deploy action is ask -> confirm -> progress -> result, all as edits
 * to the same message, so a tap never looks like it silently did nothing. */
export async function handleOperationsCallback(ctx: Context, backendDb: BackendDb, config: BackendConfig): Promise<boolean> {
  const data = ctx.callbackQuery?.data ?? "";
  const locale = botLocale(backendDb, ctx.from?.id ?? 0);

  const rollbackAsk = parseDeploymentRollbackAskCallback(data);
  if (rollbackAsk) return askConfirmation(ctx, locale, "rollback", rollbackAsk.target, rollbackAsk.revision);

  const promoteAsk = parseDeploymentPromoteAskCallback(data);
  if (promoteAsk) return askConfirmation(ctx, locale, "promote", promoteAsk.target, promoteAsk.revision);

  const menuRevision = parseDeploymentMenuCallback(data);
  if (menuRevision) {
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(deploymentMenuText(locale, menuRevision), {
      reply_markup: deploymentMenuKeyboard(locale, menuRevision),
    });
    return true;
  }

  if (data === "deploy_cancel") {
    await ctx.answerCallbackQuery({ text: t(locale, "ops.cancelled") });
    await ctx.editMessageText(t(locale, "ops.cancelled-body"), { reply_markup: new InlineKeyboard() });
    return true;
  }

  const rollback = parseDeploymentRollbackCallback(data);
  if (rollback) {
    await runDeployAction(ctx, locale, data, rollback.revision, t(locale, "ops.rolling-back", { target: rollback.target }), () =>
      requestDeploymentRollback(config, rollback.target, rollback.revision),
    );
    return true;
  }

  const promote = parseDeploymentPromoteCallback(data);
  if (promote) {
    const progress = t(locale, "ops.deploying", { target: promote.target, revision: promote.revision.slice(0, 12) });
    await runDeployAction(ctx, locale, data, promote.revision, progress, () =>
      requestDeploymentPromote(config, promote.target, promote.revision),
    );
    return true;
  }

  return false;
}

async function askConfirmation(
  ctx: Context,
  locale: StudioLocale,
  action: "rollback" | "promote",
  target: string,
  revision: string,
): Promise<boolean> {
  await ctx.answerCallbackQuery();
  const question =
    action === "rollback"
      ? t(locale, "ops.rollback-q", { target })
      : t(locale, "ops.promote-q", { target, revision: revision.slice(0, 12) });
  const confirmData = action === "rollback" ? `deploy_rollback:${target}:${revision}` : `deploy_promote:${target}:${revision}`;
  const original = ctx.callbackQuery?.message && "text" in ctx.callbackQuery.message ? ctx.callbackQuery.message.text : undefined;
  await ctx.editMessageText(`${original ? `${original}\n\n` : ""}⚠️ ${question}`, {
    reply_markup: new InlineKeyboard()
      .text(t(locale, "common.confirm"), confirmData)
      .text(t(locale, "common.back"), deploymentMenuCallback(revision)),
  });
  return true;
}

async function runDeployAction(
  ctx: Context,
  locale: StudioLocale,
  lockKey: string,
  menuRevision: string,
  progressText: string,
  action: () => Promise<{ ok: true; release: string; currentRevision: string } | { ok: false; message: string }>,
): Promise<void> {
  await ctx.answerCallbackQuery();
  await ctx.editMessageText(progressText, { reply_markup: new InlineKeyboard() });
  // Deliberately not awaited: the bot polls updates one at a time, and this
  // request alone can take up to ~150s (agent healthcheck plus image pull).
  // Awaiting it here would freeze every chat's buttons and messages until it
  // resolves. Let it run in the background and edit this message once it's done.
  // withActionLock stops a double tap on the confirm button from firing the
  // request twice before the button even disappears.
  void withActionLock(lockKey, action)
    .then((result) => (result.ok ? finishDeployAction(ctx, locale, result.value, menuRevision) : undefined))
    .catch((error) =>
      finishDeployAction(ctx, locale, { ok: false, message: error instanceof Error ? error.message : String(error) }, menuRevision),
    );
}

async function finishDeployAction(
  ctx: Context,
  locale: StudioLocale,
  result: { ok: true; release: string; currentRevision: string } | { ok: false; message: string },
  fallbackRevision: string,
): Promise<void> {
  const finalText = result.ok
    ? t(locale, "ops.done", { revision: result.currentRevision.slice(0, 12) })
    : t(locale, "ops.failed", { message: result.message });
  const revision = result.ok ? result.currentRevision : fallbackRevision;
  const body = `${finalText}\n\n${deploymentMenuText(locale, revision)}`;
  const reply_markup = deploymentMenuKeyboard(locale, revision);
  try {
    await ctx.editMessageText(body, { reply_markup });
  } catch {
    await ctx.reply(body, { reply_markup });
  }
}

function deploymentMenuKeyboard(locale: StudioLocale, revision: string): InlineKeyboard {
  return new InlineKeyboard()
    .text(t(locale, "ops.rollback-btn", { target: "alex" }), `deploy_rb_ask:alex:${revision}`)
    .row()
    .text(t(locale, "ops.promote-btn", { target: "maru" }), `deploy_pr_ask:maru:${revision}`)
    .row()
    .text(t(locale, "ops.promote-btn", { target: "worker" }), `deploy_pr_ask:worker:${revision}`);
}

function deploymentMenuText(locale: StudioLocale, revision: string): string {
  return t(locale, "ops.menu", { revision: revision.slice(0, 12) });
}
