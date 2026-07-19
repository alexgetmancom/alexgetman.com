import type { BackendDb } from "../db/client.js";
import type { BackendConfig } from "../foundation/config.js";
import type { StudioLocale } from "../foundation/locale.js";
import { renderStudioSection } from "../interfaces/web/studio.js";
import {
  renderAudienceSection,
  renderCredentialsSection,
  renderDiagnosticsSection,
  renderQueueSection,
  renderRepairSection,
} from "./dashboard/ops-sections.js";
import { renderPipelineSection } from "./dashboard/pipeline-section.js";
import { renderDashboardShell } from "./dashboard/shell.js";
import { renderVideoSection } from "./dashboard/video-section.js";
import { operationsService } from "./service.js";

type DashboardTab = "posts" | "video" | "studio";

export function renderDashboard(
  config: BackendConfig,
  backendDb: BackendDb,
  weekOffset: number,
  ref = "",
  messageId = "",
  requestedTab?: string,
  requestedLocale?: string,
): string {
  const service = operationsService(backendDb, config);
  const ops = service.dashboard();
  const studioActorId = config.MCP_STUDIO_ACTOR_ID;
  let tab: DashboardTab =
    requestedTab === "video"
      ? "video"
      : requestedTab === "posts"
        ? "posts"
        : requestedTab === "studio" && studioActorId
          ? "studio"
          : config.studio.commandCenter.defaultMode;
  if (tab === "posts" && !config.studio.modules.text_posting) tab = "video";
  if (tab === "video" && !config.studio.modules.video_posting) tab = "posts";
  const showPosts = tab === "posts" && config.studio.modules.text_posting;
  const showVideo = tab === "video" && config.studio.modules.video_posting;
  const showStudio = tab === "studio" && Boolean(studioActorId);
  const activeTab = showStudio ? "studio" : showVideo ? "video" : "posts";
  const locale: StudioLocale = requestedLocale === "en" ? "en" : "ru";
  const body = `
    <nav class="dashboard-tabs">${config.studio.modules.text_posting ? `<a class="${activeTab === "posts" ? "active" : ""}" href="/command-center?tab=posts">Обзор</a>` : ""}${config.studio.modules.video_posting ? `<a class="${activeTab === "video" ? "active" : ""}" href="/command-center?tab=video">Видео</a>` : ""}${studioActorId ? `<a class="${activeTab === "studio" ? "active" : ""}" href="/command-center?tab=studio">Студия</a>` : ""}<a href="#queue">Очередь</a><a href="#health">Health</a></nav>
    <section id="overview" class="overview">${showPosts ? `${renderAudienceSection(backendDb, config)}${renderPipelineSection(weekOffset, service.pipeline(weekOffset))}` : ""}${showVideo ? renderVideoSection(backendDb) : ""}${showStudio && studioActorId ? renderStudioSection(config, backendDb, studioActorId, locale) : ""}</section>
    <details id="queue"><summary>Queue и черновики</summary>${renderQueueSection(ops)}</details>
    <details id="health"><summary>Health: credentials и diagnostics</summary>${renderCredentialsSection(ops)}${renderDiagnosticsSection(ops)}</details>
    <details id="repair"><summary>Emergency repair</summary>${renderRepairSection(ref, messageId)}</details>`;
  return renderDashboardShell(body);
}

export function renderCommandCenterLogin(error = false): string {
  return renderDashboardShell(
    `<section class="command-login"><h1>Command Center</h1><p class="note">Введите Command Center token. Он сохранится в защищённой HttpOnly-cookie на 180 дней; при смене токена потребуется войти снова.</p>${error ? '<p class="login-error">Неверный token.</p>' : ""}<form method="post" action="/command-center"><input type="password" name="token" autocomplete="current-password" aria-label="Command Center token" placeholder="Command Center token" required><button type="submit">Open Command Center</button></form></section>`,
  );
}
