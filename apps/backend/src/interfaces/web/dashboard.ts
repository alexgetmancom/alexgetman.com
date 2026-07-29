import { xActivityDashboard } from "../../analytics/x-activity-dashboard.js";
import type { BackendDb } from "../../db/client.js";
import type { BackendConfig } from "../../foundation/config.js";
import type { StudioLocale } from "../../foundation/locale.js";
import { operationsService } from "../../operations/service.js";
import {
  renderAudienceSection,
  renderCredentialsSection,
  renderDiagnosticsSection,
  renderQueueSection,
  renderRepairSection,
} from "./dashboard/ops-sections.js";
import { renderPeriodControls, renderPipelineSection, rollingPeriodDates } from "./dashboard/pipeline-section.js";
import { renderDashboardShell } from "./dashboard/shell.js";
import { DASHBOARD_THEME_TOGGLE_HTML } from "./dashboard/theme.js";
import { renderVideoSection } from "./dashboard/video-section.js";
import { renderXSection } from "./dashboard/x-section.js";
import { renderStudioSection } from "./studio.js";

type DashboardTab = "posts" | "video" | "studio";
type DashboardPanel = "overview" | "queue" | "health" | "repair";

export function renderDashboard(
  config: BackendConfig,
  backendDb: BackendDb,
  weekOffset: number,
  ref = "",
  messageId = "",
  requestedTab?: string,
  requestedLocale?: string,
  requestedPanel?: string,
  requestedPeriod?: string,
  requestedView?: string,
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
  const panel: DashboardPanel =
    requestedPanel === "queue" || requestedPanel === "health" || requestedPanel === "repair" ? requestedPanel : "overview";
  const periodDays = [1, 7, 30, 90, 365].includes(Number(requestedPeriod)) ? Number(requestedPeriod) : 1;
  const activeView = requestedView === "x" && showPosts ? "x" : undefined;
  const panelLink = (value: DashboardPanel) => `/command-center?tab=posts&panel=${value}${periodDays !== 1 ? `&period=${periodDays}` : ""}`;
  const overviewControls =
    panel === "overview" && showPosts ? renderPeriodControls(weekOffset, periodDays, config.TIMEZONE, activeView) : "";
  const content = renderPanel();

  function renderPanel(): string {
    switch (panel) {
      case "queue":
        return renderQueueSection(ops);
      case "health":
        return `${renderCredentialsSection(ops)}${renderDiagnosticsSection(ops)}`;
      case "repair":
        return renderRepairSection(ref, messageId);
      default:
        return renderOverview();
    }
  }

  function renderOverview(): string {
    if (showPosts) {
      if (activeView === "x") {
        const [start, end] = rollingPeriodDates(weekOffset, periodDays, config.TIMEZONE);
        return renderXSection(
          xActivityDashboard(backendDb, weekOffset, periodDays, config.TIMEZONE),
          xActivityDashboard(backendDb, weekOffset + 1, periodDays, config.TIMEZONE),
          renderAudienceSection(backendDb, config, "x", periodDays, weekOffset),
          start,
          end,
        );
      }
      // A one-day period is shown against the preceding 30 days plus the
      // preceding single day; every longer period compares against itself.
      const comparison =
        periodDays === 1
          ? { baseline: service.pipeline(0, 30, 0, weekOffset + 1), days: 30, previousDay: service.pipeline(0, 1, 0, weekOffset + 1) }
          : { baseline: service.pipeline(weekOffset, periodDays, 1), days: periodDays, previousDay: null };
      return renderPipelineSection(
        weekOffset,
        periodDays,
        service.pipeline(weekOffset, periodDays),
        comparison.baseline,
        renderAudienceSection(backendDb, config, undefined, periodDays, weekOffset),
        config.TIMEZONE,
        comparison.days,
        comparison.previousDay,
      );
    }
    if (showVideo) return renderVideoSection(backendDb);
    if (showStudio && studioActorId) return renderStudioSection(config, backendDb, studioActorId, locale);
    return "";
  }

  const body = `
    <nav class="dashboard-tabs">${config.studio.modules.text_posting ? `<a class="${panel === "overview" && activeTab === "posts" ? "active" : ""}" href="${panelLink("overview")}">Обзор</a>` : ""}<a class="${panel === "queue" ? "active" : ""}" href="${panelLink("queue")}">Очередь</a><a class="${panel === "health" ? "active" : ""}" href="${panelLink("health")}">Health</a><a class="${panel === "repair" ? "active" : ""}" href="${panelLink("repair")}">Repair</a>${config.studio.modules.video_posting ? `<a class="${panel === "overview" && activeTab === "video" ? "active" : ""}" href="/command-center?tab=video">Видео</a>` : ""}${studioActorId ? `<a class="${panel === "overview" && activeTab === "studio" ? "active" : ""}" href="/command-center?tab=studio">Студия</a>` : ""}<span class="dashboard-tabs__end">${overviewControls}${DASHBOARD_THEME_TOGGLE_HTML}</span></nav>
    <section id="overview" class="overview">${content}</section>`;
  return renderDashboardShell(body);
}

export function renderCommandCenterLogin(error = false): string {
  return renderDashboardShell(
    `<section class="command-login"><h1>Command Center</h1><p class="note">Введите Command Center token. Он сохранится в защищённой HttpOnly-cookie на 180 дней; при смене токена потребуется войти снова.</p>${error ? '<p class="login-error">Неверный token.</p>' : ""}<form method="post" action="/command-center"><input type="password" name="token" autocomplete="current-password" aria-label="Command Center token" placeholder="Command Center token" required><button type="submit">Open Command Center</button></form></section>`,
  );
}
