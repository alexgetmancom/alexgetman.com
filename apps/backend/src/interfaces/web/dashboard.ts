import { xActivityDashboard } from "../../analytics/x-activity-dashboard.js";
import type { BackendDb } from "../../db/client.js";
import type { BackendConfig } from "../../foundation/config.js";
import type { StudioLocale } from "../../foundation/locale.js";
import { zonedSlot } from "../../foundation/time.js";
import { operationsService } from "../../operations/service.js";
import { type OverviewMode, type PlatformMetric, renderCombinedSection, renderModeFilter } from "./dashboard/combined-section.js";
import {
  audiencePlatformFollowers,
  renderAudienceSection,
  renderCredentialsSection,
  renderDiagnosticsSection,
  renderQueueSection,
  renderRepairSection,
} from "./dashboard/ops-sections.js";
import { renderPeriodControls, renderPipelineSection, rollingPeriodDates } from "./dashboard/pipeline-section.js";
import { renderDashboardShell } from "./dashboard/shell.js";
import { DASHBOARD_THEME_TOGGLE_HTML } from "./dashboard/theme.js";
import type { OpsPayload, PipelineData, PipelinePost } from "./dashboard/types.js";
import { emptyVideoOverview, videoOverview } from "./dashboard/video-overview.js";
import { renderXSection } from "./dashboard/x-section.js";
import { renderStudioSection } from "./studio.js";

type DashboardTab = "posts" | "studio";
type DashboardPanel = "overview" | "queue" | "health" | "repair";
type AudienceView = "threads_ru" | "threads_en" | "telegram" | "x";

const AUDIENCE_VIEWS: AudienceView[] = ["threads_ru", "threads_en", "telegram", "x"];
const VIEW_TARGETS: Record<Exclude<AudienceView, "x">, string[]> = {
  threads_ru: ["threads_ru"],
  threads_en: ["threads_en"],
  telegram: ["telegram"],
};
const VIEW_TITLES: Record<Exclude<AudienceView, "x">, string> = {
  threads_ru: "Динамика Threads RU",
  threads_en: "Динамика Threads EN",
  telegram: "Динамика Telegram",
};

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
  requestedMode?: string,
  requestedMetric?: string,
): string {
  const service = operationsService(backendDb, config);
  const ops = service.dashboard();
  const studioActorId = config.MCP_STUDIO_ACTOR_ID;
  // The unified overview is the landing screen of every Studio, whichever
  // halves it publishes.
  const tab: DashboardTab = requestedTab === "studio" && studioActorId ? "studio" : "posts";
  const showPosts = tab === "posts";
  const showStudio = tab === "studio" && Boolean(studioActorId);
  const activeTab = showStudio ? "studio" : "posts";
  const locale: StudioLocale = requestedLocale === "en" ? "en" : "ru";
  const panel: DashboardPanel =
    requestedPanel === "queue" || requestedPanel === "health" || requestedPanel === "repair" ? requestedPanel : "overview";
  const periodDays = [1, 7, 30, 90, 365].includes(Number(requestedPeriod)) ? Number(requestedPeriod) : 1;
  const activeView =
    showPosts && config.studio.modules.text_posting && AUDIENCE_VIEWS.includes(requestedView as AudienceView)
      ? (requestedView as AudienceView)
      : undefined;
  // "Все" is the landing view of every Studio that publishes both halves — the
  // whole point of the unified overview is that the account is one thing.
  // Publishing one half only leaves nothing to combine, so those open on the
  // half that exists rather than on a view half of which is permanently empty.
  const mode: OverviewMode =
    requestedMode === "text" || requestedMode === "video"
      ? requestedMode
      : !config.studio.modules.video_posting
        ? "text"
        : config.studio.modules.text_posting
          ? "all"
          : "video";
  const platformMetric: PlatformMetric = requestedMetric === "followers" ? "followers" : "reach";
  const panelLink = (value: DashboardPanel) => `/command-center?tab=posts&panel=${value}${periodDays !== 1 ? `&period=${periodDays}` : ""}`;
  const overviewFilterQuery = !activeView
    ? `${mode === "all" ? "" : `&mode=${mode}`}${platformMetric === "followers" ? "&metric=followers" : ""}`
    : "";
  const overviewControls =
    panel === "overview" && showPosts ? renderPeriodControls(weekOffset, periodDays, config.TIMEZONE, activeView, overviewFilterQuery) : "";
  const content = renderPanel();

  /** rollingPeriodDates hands back UTC-midnight Dates whose calendar fields
   * carry the configured zone's date. Video publications are stored as real
   * instants, so the window has to be resolved back into instants before it can
   * be compared against published_at. */
  function dayBounds(date: Date, endOfDay = false): Date {
    const start = zonedSlot(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), "00:00", config.TIMEZONE);
    return endOfDay ? new Date(start.getTime() + 86_400_000 - 1) : start;
  }

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
      if (!activeView) {
        const [start, end] = rollingPeriodDates(weekOffset, periodDays, config.TIMEZONE);
        const comparisonPipeline =
          periodDays === 1
            ? service.pipeline(0, 30, 0, weekOffset + 1, { includeSamples: false })
            : service.pipeline(weekOffset + 1, periodDays, 0, undefined, { includeSamples: false });
        const comparisonX =
          periodDays === 1
            ? xActivityDashboard(backendDb, (weekOffset + 1) / 30, 30, config.TIMEZONE)
            : xActivityDashboard(backendDb, weekOffset + 1, periodDays, config.TIMEZONE);
        // The video read model is period-scoped the same way the pipeline is:
        // this period, the comparison baseline, and — for a single day — the
        // day before, so both halves of the chart answer to one clock.
        const [yesterdayStart, yesterdayEnd] = rollingPeriodDates(weekOffset + 1, 1, config.TIMEZONE);
        // A single day is judged against the 30 days ending yesterday, matching
        // the text baseline. rollingPeriodDates shifts by offset*days, so that
        // window cannot be asked for as (weekOffset + 1, 30) — that lands a
        // month earlier.
        const previousEnd = periodDays === 1 ? yesterdayEnd : rollingPeriodDates(weekOffset + 1, periodDays, config.TIMEZONE)[1];
        const previousStart =
          periodDays === 1 ? shiftDays(yesterdayEnd, -29) : rollingPeriodDates(weekOffset + 1, periodDays, config.TIMEZONE)[0];
        const videoEnabled = config.studio.modules.video_posting;
        return renderCombinedSection({
          data: service.pipeline(weekOffset, periodDays, 0, undefined, { includeSamples: periodDays === 1 }),
          previousData: comparisonPipeline,
          xItems: xActivityDashboard(backendDb, weekOffset, periodDays, config.TIMEZONE),
          previousXItems: comparisonX,
          dayComparisonData: periodDays === 1 ? service.pipeline(0, 1, 0, weekOffset + 1, { includeSamples: true }) : null,
          video: videoEnabled ? videoOverview(backendDb, dayBounds(start), dayBounds(end, true), config.TIMEZONE) : emptyVideoOverview(),
          previousVideo: videoEnabled
            ? videoOverview(backendDb, dayBounds(previousStart), dayBounds(previousEnd, true), config.TIMEZONE)
            : emptyVideoOverview(),
          dayComparisonVideo:
            videoEnabled && periodDays === 1
              ? videoOverview(backendDb, dayBounds(yesterdayStart), dayBounds(yesterdayEnd, true), config.TIMEZONE)
              : null,
          followers: audiencePlatformFollowers(backendDb),
          rangeStart: start,
          rangeEnd: end,
          periodDays,
          weekOffset,
          timeZone: config.TIMEZONE,
          mode,
          platformMetric,
        });
      }
      const targetIds = VIEW_TARGETS[activeView];
      // A one-day period is shown against the preceding 30 days plus the
      // preceding single day; every longer period compares against itself.
      const comparison =
        periodDays === 1
          ? {
              baseline: service.pipeline(0, 30, 0, weekOffset + 1, { includeSamples: false }),
              days: 30,
              previousDay: service.pipeline(0, 1, 0, weekOffset + 1, { includeSamples: true }),
            }
          : {
              baseline: service.pipeline(weekOffset, periodDays, 1, undefined, { includeSamples: false }),
              days: periodDays,
              previousDay: null,
            };
      return renderPipelineSection(
        weekOffset,
        periodDays,
        filterPipeline(service.pipeline(weekOffset, periodDays, 0, undefined, { includeSamples: periodDays === 1 }), targetIds),
        filterPipeline(comparison.baseline, targetIds),
        renderAudienceSection(backendDb, config, activeView, periodDays, weekOffset),
        config.TIMEZONE,
        comparison.days,
        filterPipeline(comparison.previousDay, targetIds),
        { targetIds, title: VIEW_TITLES[activeView] },
      );
    }
    if (showStudio && studioActorId) return renderStudioSection(config, backendDb, studioActorId, locale);
    return "";
  }

  // Everything except the overview lives behind the overflow menu: the operator
  // opens Queue, Health, Repair and Video rarely, and spelled out they cost the
  // widest, tallest row on the screen. The one thing that must not be hidden is
  // a problem, so the menu carries a dot when Health has something to say.
  const secondaryTabs = [
    { label: "Очередь", href: panelLink("queue"), active: panel === "queue" },
    { label: "Health", href: panelLink("health"), active: panel === "health", attention: opsNeedsAttention(ops) },
    { label: "Repair", href: panelLink("repair"), active: panel === "repair" },
    ...(studioActorId
      ? [{ label: "Студия", href: "/command-center?tab=studio", active: panel === "overview" && activeTab === "studio" }]
      : []),
  ];
  const activeSecondary = secondaryTabs.find((tab) => tab.active);
  const attention = secondaryTabs.some((tab) => tab.attention);
  const overviewTab = `<a class="${panel === "overview" && activeTab === "posts" ? "active" : ""}" href="${panelLink("overview")}">Обзор</a>`;
  // Not open on arrival even when one of its entries is the current section:
  // the panel would drop over the content the operator just navigated to. The
  // control names the section instead.
  const menu = `<details class="nav-more">
    <summary class="nav-more__toggle${activeSecondary ? " active" : ""}${attention ? " nav-more__toggle--attention" : ""}" aria-label="Другие разделы">${activeSecondary ? escapeHtml(activeSecondary.label) : "···"}</summary>
    <div class="nav-more__menu">${secondaryTabs
      .map(
        (tab) =>
          `<a class="${tab.active ? "active" : ""}" href="${tab.href}">${escapeHtml(tab.label)}${tab.attention ? '<i class="nav-dot"></i>' : ""}</a>`,
      )
      .join("")}</div>
  </details>`;
  // Nothing to filter when the Studio publishes one half only.
  const bothHalves = config.studio.modules.text_posting && config.studio.modules.video_posting;
  const modeFilter =
    panel === "overview" && showPosts && !activeView && bothHalves ? renderModeFilter(mode, periodDays, weekOffset, platformMetric) : "";
  const body = `
    <nav class="dashboard-tabs"><span class="dashboard-tabs__start">${overviewTab}${menu}</span><span class="dashboard-tabs__center">${modeFilter}</span><span class="dashboard-tabs__end">${overviewControls}${DASHBOARD_THEME_TOGGLE_HTML}</span></nav>
    <section id="overview" class="overview">${content}</section>`;
  return renderDashboardShell(body);
}

/** Health is the one hidden tab whose state the operator must see without
 * opening it: a failed publish job, a broken credential, or a metric target
 * that stopped reporting. */
function opsNeedsAttention(ops: OpsPayload): boolean {
  if (ops.jobs?.some((job) => job.status === "failed")) return true;
  if (ops.credentials?.some((credential) => credential.status && !["ok", "ready"].includes(credential.status))) return true;
  return Boolean(ops.pipeline?.metrics?.recent?.some((issue) => issue.error || issue.status === "failed"));
}

const HTML_ENTITIES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => HTML_ENTITIES[char] ?? char);
}

function shiftDays(date: Date, days: number): Date {
  const shifted = new Date(date);
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted;
}

function filterPipeline(data: PipelineData | null, targetIds: string[]): PipelineData | null {
  if (!data) return null;
  return { ...data, posts: (data.posts ?? []).filter((post) => targetIds.some((target) => postHasTarget(post, target))) };
}

function postHasTarget(post: PipelinePost, target: string): boolean {
  if (post.targets?.[target]?.status === "published") return true;
  if (target === "telegram" && post.telegram_url) return true;
  return Boolean(post.metrics?.[target]);
}

export function renderCommandCenterLogin(error = false): string {
  return renderDashboardShell(
    `<section class="command-login"><h1>Command Center</h1><p class="note">Введите Command Center token. Он сохранится в защищённой HttpOnly-cookie на 180 дней; при смене токена потребуется войти снова.</p>${error ? '<p class="login-error">Неверный token.</p>' : ""}<form method="post" action="/command-center"><input type="password" name="token" autocomplete="current-password" aria-label="Command Center token" placeholder="Command Center token" required><button type="submit">Open Command Center</button></form></section>`,
  );
}
