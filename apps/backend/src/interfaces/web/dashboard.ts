import type { XActivityDashboardItem } from "../../analytics/x-activity-dashboard.js";
import { xActivityDashboard } from "../../analytics/x-activity-dashboard.js";
import { AUDIENCE_VIEWS, type AudienceView } from "../../botTargets.js";
import type { BackendDb } from "../../db/client.js";
import type { BackendConfig } from "../../foundation/config.js";
import type { StudioLocale } from "../../foundation/locale.js";
import { type CommandCenterAttention, createOperationsService } from "../../operations/index.js";
import { type PlatformMetric, renderCombinedSection } from "./dashboard/combined-section.js";
import { renderCredentialsSection, renderDiagnosticsSection, renderQueueSection, renderRepairSection } from "./dashboard/ops-sections.js";
import { buildOverviewData, videoOverviewForPeriod } from "./dashboard/overview-data.js";
import { renderPeriodControls } from "./dashboard/period-controls.js";
import { renderDashboardShell } from "./dashboard/shell.js";
import { type PublicationDetailsResult, renderPublicationDetails } from "./dashboard/table.js";
import { DASHBOARD_THEME_TOGGLE_HTML } from "./dashboard/theme.js";
import type { OpsPayload, PipelineData, PipelinePost } from "./dashboard/types.js";
import { createVideoOverviewCache, invalidateVideoOverviewCache } from "./dashboard/video-overview.js";
import { renderStudioSection } from "./studio.js";

type DashboardTab = "posts" | "studio";
type DashboardPanel = "overview" | "queue" | "health" | "repair";
const DASHBOARD_CACHE_TTL_MS = 10_000;
const MAX_DASHBOARD_CACHE_ENTRIES = 5;
type DashboardCacheEntry = { expiresAt: number; html: string };
const dashboardCaches = new WeakMap<BackendDb, Map<string, DashboardCacheEntry>>();

function dashboardCacheFor(backendDb: BackendDb): Map<string, DashboardCacheEntry> {
  const existing = dashboardCaches.get(backendDb);
  if (existing) return existing;
  const created = new Map<string, DashboardCacheEntry>();
  dashboardCaches.set(backendDb, created);
  return created;
}

function dashboardCacheKey(
  config: BackendConfig,
  weekOffset: number,
  ref: string,
  messageId: string,
  requestedTab: string | undefined,
  requestedLocale: string | undefined,
  requestedPanel: string | undefined,
  requestedPeriod: string | undefined,
  requestedView: string | undefined,
  requestedMetric: string | undefined,
): string {
  return JSON.stringify({
    timezone: config.TIMEZONE,
    textPosting: config.studio.modules.text_posting,
    videoPosting: config.studio.modules.video_posting,
    studioActorId: config.MCP_STUDIO_ACTOR_ID ?? null,
    request: [
      weekOffset,
      ref,
      messageId,
      requestedTab ?? null,
      requestedLocale ?? null,
      requestedPanel ?? null,
      requestedPeriod ?? null,
      requestedView ?? null,
      requestedMetric ?? null,
    ],
  });
}

function rememberDashboard(cache: Map<string, DashboardCacheEntry>, key: string, html: string, now: number): void {
  cache.delete(key);
  cache.set(key, { expiresAt: now + DASHBOARD_CACHE_TTL_MS, html });
  while (cache.size > MAX_DASHBOARD_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (typeof oldest !== "string") break;
    cache.delete(oldest);
  }
}

/** Clears the short-lived HTML cache after an authenticated dashboard mutation. */
export function invalidateDashboardRenderCache(backendDb: BackendDb): void {
  dashboardCaches.delete(backendDb);
  invalidateVideoOverviewCache(backendDb);
}

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
  requestedMetric?: string,
): string {
  const cache = dashboardCacheFor(backendDb);
  const cacheKey = dashboardCacheKey(
    config,
    weekOffset,
    ref,
    messageId,
    requestedTab,
    requestedLocale,
    requestedPanel,
    requestedPeriod,
    requestedView,
    requestedMetric,
  );
  const now = Date.now();
  const cached = cache.get(cacheKey);
  if (cached) {
    if (cached.expiresAt > now) {
      cache.delete(cacheKey);
      cache.set(cacheKey, cached);
      return cached.html;
    }
    cache.delete(cacheKey);
  }
  const service = createOperationsService(backendDb, config);
  const videoCache = createVideoOverviewCache();
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
  const ops = panel === "queue" || panel === "health" ? service.dashboard() : null;
  const hasAttention = ops ? opsNeedsAttention(ops) : commandCenterAttentionState(service.attention());
  const periodDays = [1, 7, 30, 90, 365].includes(Number(requestedPeriod)) ? Number(requestedPeriod) : 1;
  const activeView =
    showPosts && config.studio.modules.text_posting && AUDIENCE_VIEWS.includes(requestedView as AudienceView)
      ? (requestedView as AudienceView)
      : undefined;
  const platformMetric: PlatformMetric = requestedMetric === "followers" ? "followers" : "reach";
  const panelLink = (value: DashboardPanel) => `/command-center?tab=posts&panel=${value}${periodDays !== 1 ? `&period=${periodDays}` : ""}`;
  const overviewFilterQuery = platformMetric === "followers" ? "&metric=followers" : "";
  const overviewControls =
    panel === "overview" && showPosts ? renderPeriodControls(weekOffset, periodDays, config.TIMEZONE, activeView, overviewFilterQuery) : "";
  const content = renderPanel();

  function renderPanel(): string {
    switch (panel) {
      case "queue":
        return renderQueueSection(ops ?? {});
      case "health":
        return `${renderCredentialsSection(ops ?? {})}${renderDiagnosticsSection(ops ?? {})}`;
      case "repair":
        return renderRepairSection(ref, messageId);
      default:
        return renderOverview();
    }
  }

  function renderOverview(): string {
    if (showPosts)
      return renderCombinedSection(
        buildOverviewData(config, backendDb, service, videoCache, weekOffset, periodDays, activeView, platformMetric),
      );
    if (showStudio && studioActorId) return renderStudioSection(config, backendDb, studioActorId, locale);
    return "";
  }

  // Everything except the overview lives behind the overflow menu: the operator
  // opens Queue, Health, Repair and Video rarely, and spelled out they cost the
  // widest, tallest row on the screen. The one thing that must not be hidden is
  // a problem, so the menu carries a dot when Health has something to say.
  const secondaryTabs = [
    { label: "Очередь", href: panelLink("queue"), active: panel === "queue" },
    { label: "Health", href: panelLink("health"), active: panel === "health", attention: hasAttention },
    { label: "Repair", href: panelLink("repair"), active: panel === "repair" },
    ...(studioActorId
      ? [{ label: "Студия", href: "/command-center?tab=studio", active: panel === "overview" && activeTab === "studio" }]
      : []),
  ];
  const activeSecondary = secondaryTabs.find((tab) => tab.active);
  const menuAttention = secondaryTabs.some((tab) => tab.attention);
  const overviewTab = `<a class="${panel === "overview" && activeTab === "posts" ? "active" : ""}" href="${panelLink("overview")}">Обзор</a>`;
  // Not open on arrival even when one of its entries is the current section:
  // the panel would drop over the content the operator just navigated to. The
  // control names the section instead.
  const menu = `<details class="nav-more">
    <summary class="nav-more__toggle${activeSecondary ? " active" : ""}${menuAttention ? " nav-more__toggle--attention" : ""}" aria-label="Другие разделы">${activeSecondary ? escapeHtml(activeSecondary.label) : "···"}</summary>
    <div class="nav-more__menu">${secondaryTabs
      .map(
        (tab) =>
          `<a class="${tab.active ? "active" : ""}" href="${tab.href}">${escapeHtml(tab.label)}${tab.attention ? '<i class="nav-dot"></i>' : ""}</a>`,
      )
      .join("")}</div>
  </details>`;
  // The overview is one complete Studio surface: text and video stay side by
  // side, with only the period, platform and metric filters remaining.
  const body = `
    <nav class="dashboard-tabs"><span class="dashboard-tabs__start">${overviewTab}${menu}</span><span class="dashboard-tabs__end">${overviewControls}${DASHBOARD_THEME_TOGGLE_HTML}</span></nav>
    <section id="overview" class="overview">${content}</section>`;
  const html = renderDashboardShell(body);
  rememberDashboard(cache, cacheKey, html, now);
  return html;
}

/** Builds only the bounded read-only fragment requested by the dashboard list. */
export function renderDashboardPublicationDetails(
  config: BackendConfig,
  backendDb: BackendDb,
  weekOffset: number,
  periodDays: number,
  requestedView: string | undefined,
  offset: number,
  limit: number,
): PublicationDetailsResult {
  const targetIds = dashboardTargetIds(requestedView);
  const data = createOperationsService(backendDb, config).pipelineOverview(weekOffset, periodDays, 0, undefined, {
    includeSamples: false,
    includeContent: true,
    contentLimit: offset + limit,
  });
  const posts = targetIds ? (filterPipeline(data, targetIds)?.posts ?? []) : (data?.posts ?? []);
  const xItems = requestedView === "x" ? xActivityDashboard(backendDb, weekOffset, periodDays, config.TIMEZONE) : [];
  const representedPostKeys = new Set(posts.map((post) => post.post_key).filter((key): key is string => Boolean(key)));
  const xPosts = xItems.filter((item) => !item.linkedPostKey || !representedPostKeys.has(item.linkedPostKey)).map(xActivityPipelinePost);
  const videos =
    requestedView || !config.studio.modules.video_posting ? [] : videoOverviewForPeriod(backendDb, weekOffset, periodDays, config).items;
  return renderPublicationDetails([...posts, ...xPosts], targetIds ?? (requestedView === "x" ? ["x"] : undefined), videos, offset, limit);
}

/** Health is the one hidden tab whose state the operator must see without
 * opening it: a failed publish job, a broken credential, or a metric target
 * that stopped reporting. */
function opsNeedsAttention(ops: OpsPayload): boolean {
  if (ops.jobs?.some((job) => job.status === "failed")) return true;
  if (ops.credentials?.some((credential) => credential.status && !["ok", "ready"].includes(credential.status))) return true;
  return Boolean(ops.pipeline?.metrics?.recent?.some((issue) => issue.error || issue.status === "failed"));
}

function commandCenterAttentionState(attention: CommandCenterAttention): boolean {
  return attention.hasFailedJob || attention.hasCredentialIssue || attention.hasMetricIssue;
}

function dashboardTargetIds(requestedView: string | undefined): string[] | undefined {
  if (requestedView && AUDIENCE_VIEWS.includes(requestedView as AudienceView)) return [requestedView];
  return undefined;
}

function xActivityPipelinePost(item: XActivityDashboardItem): PipelinePost {
  return {
    post_key: `x-activity:${item.xPostId}`,
    date: item.publishedAt,
    text_en: item.text,
    targets: { x: { status: "published", url: item.url } },
    metrics: {
      x: {
        views: { value: Number(item.metrics.views ?? 0) },
        likes: { value: Number(item.metrics.interactions ?? 0) },
        replies: { value: Number(item.metrics.replies ?? 0) },
      },
    },
  };
}

const HTML_ENTITIES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => HTML_ENTITIES[char] ?? char);
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
