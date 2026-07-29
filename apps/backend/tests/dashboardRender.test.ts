import { describe, expect, it } from "bun:test";
import { formatMetricValue, getMskDateString, shortPipelineText } from "../src/interfaces/web/dashboard/format.js";
import { formatMedia, getTargetMetric, postMetricTotals, targetCell } from "../src/interfaces/web/dashboard/metrics.js";
import { renderPublicationColumns } from "../src/interfaces/web/dashboard/table.js";
import { getTargetUrl } from "../src/interfaces/web/dashboard/target-url.js";
import type { PipelinePost } from "../src/interfaces/web/dashboard/types.js";

function post(overrides: Partial<PipelinePost> = {}): PipelinePost {
  return { post_id: 106, ...overrides };
}

/** A published target with the given metric values, the only shape
 * getTargetMetric will read: it returns 0 for anything not published. */
function published(target: string, metrics: Record<string, number> = {}): Partial<PipelinePost> {
  return {
    targets: { [target]: { status: "published" } },
    metrics: { [target]: Object.fromEntries(Object.entries(metrics).map(([name, value]) => [name, { value }])) },
  };
}

describe("dashboard formatting", () => {
  it("distinguishes an absent metric from zero", () => {
    // Everything else about this function is cosmetic rounding. This part is
    // not: "" and "0" mean different things to the reader of the dashboard.
    expect(formatMetricValue(null)).toBe("");
    expect(formatMetricValue(undefined)).toBe("");
    expect(formatMetricValue("not a number")).toBe("");
    expect(formatMetricValue(0)).toBe("0");
  });

  it("shifts a UTC timestamp into the Moscow day", () => {
    // 22:30 UTC is already the next day in MSK (+3).
    expect(getMskDateString("2026-07-27T22:30:00.000Z")).toBe("2026-07-28");
    expect(getMskDateString("2026-07-27T10:00:00.000Z")).toBe("2026-07-27");
  });

  it("falls back to today for a missing or invalid date rather than rendering NaN", () => {
    const today = new Date().toISOString().slice(0, 10);
    expect(getMskDateString(null)).toBe(today);
    expect(getMskDateString(undefined)).toBe(today);
    expect(getMskDateString("not a date")).toBe(today);
  });

  it("survives a missing title instead of rendering the word null", () => {
    expect(shortPipelineText(null)).toBe("");
    expect(shortPipelineText("")).toBe("");
  });
});

describe("dashboard target URLs", () => {
  it("builds a per-locale site path from that locale's own slug", () => {
    const withSlugs = post({ post_id: 106, slug_ru: "ru-slug", slug_en: "en-slug" });
    expect(getTargetUrl(withSlugs, "site_ru")).toBe("/ru/106/ru-slug/");
    expect(getTargetUrl(withSlugs, "site_en")).toBe("/106/en-slug/");
  });

  it("returns no site URL when that locale has no slug, instead of linking the other locale", () => {
    const englishOnly = post({ post_id: 106, slug_ru: null, slug_en: "en-slug", site_url: "/106/en-slug/" });
    expect(getTargetUrl(englishOnly, "site_ru")).toBeNull();
  });

  it("prefers the recorded telegram URL", () => {
    expect(getTargetUrl(post({ telegram_url: "https://t.me/alexgetman/106" }), "telegram")).toBe("https://t.me/alexgetman/106");
  });

  it("builds x and threads permalinks from an external id", () => {
    expect(getTargetUrl(post({ targets: { x: { external_id: "1234" } } }), "x")).toBe("https://x.com/alexgetmancom/status/1234");
    expect(getTargetUrl(post({ targets: { threads_ru: { external_id: "abc" } } }), "threads_ru")).toBe(
      "https://www.threads.com/@alexgetmanru/post/abc",
    );
    expect(getTargetUrl(post({ targets: { threads_en: { external_id: "abc" } } }), "threads_en")).toBe(
      "https://www.threads.com/@alexgetmanco/post/abc",
    );
  });

  it("rewrites a stored threads.net URL to threads.com", () => {
    expect(getTargetUrl(post({ targets: { threads_ru: { url: "https://www.threads.net/@x/post/1" } } }), "threads_ru")).toBe(
      "https://www.threads.com/@x/post/1",
    );
  });

  it("passes an external id through when it is already a URL", () => {
    expect(getTargetUrl(post({ targets: { x: { external_id: "https://x.com/i/status/9" } } }), "x")).toBe("https://x.com/i/status/9");
  });

  it("returns null for an unknown target and for a target with nothing recorded", () => {
    expect(getTargetUrl(post(), "instagram_stories")).toBeNull();
    expect(getTargetUrl(post({ targets: { x: { status: "queued" } } }), "x")).toBeNull();
  });
});

describe("dashboard metrics", () => {
  it("reads a metric only from a published target", () => {
    expect(getTargetMetric(post(published("x", { views: 500 })), "x", "views")).toBe(500);
    expect(getTargetMetric(post({ targets: { x: { status: "queued" } }, metrics: { x: { views: { value: 500 } } } }), "x", "views")).toBe(
      0,
    );
  });

  it("infers published status for telegram and site targets from their recorded URL", () => {
    expect(
      getTargetMetric(post({ telegram_url: "https://t.me/a/1", metrics: { telegram: { views: { value: 9 } } } }), "telegram", "views"),
    ).toBe(9);
    expect(getTargetMetric(post({ site_ru: "/ru/106/s/", metrics: { site_ru: { views: { value: 4 } } } }), "site_ru", "views")).toBe(4);
  });

  it("treats an absent, null or unparseable metric as zero", () => {
    expect(getTargetMetric(post(published("x")), "x", "views")).toBe(0);
    expect(getTargetMetric(post(published("x", { views: Number.NaN })), "x", "views")).toBe(0);
    expect(getTargetMetric(post(), "x", "views")).toBe(0);
  });

  it("sums every metric across the given targets", () => {
    const both: PipelinePost = {
      targets: { x: { status: "published" }, threads_ru: { status: "published" } },
      metrics: {
        x: { views: { value: 100 }, likes: { value: 5 }, replies: { value: 1 }, reposts: { value: 2 } },
        threads_ru: { views: { value: 50 }, likes: { value: 3 } },
      },
    };
    expect(postMetricTotals(both, ["x", "threads_ru"])).toEqual({ views: 150, likes: 8, replies: 1, reposts: 2 });
    expect(postMetricTotals(both, [])).toEqual({ views: 0, likes: 0, replies: 0, reposts: 0 });
  });

  it("folds bot_views into the visible site views cell", () => {
    const cell = targetCell(post({ ...published("site_ru", { views: 10, bot_views: 4 }), slug_ru: "s" }), "site_ru");
    expect(cell).toContain(">14<");
  });

  it("renders tildes while a target is still in flight and dashes when it never published", () => {
    expect(targetCell(post({ targets: { x: { status: "queued" } } }), "x")).toBe(
      '<span class="mv">~</span><span class="ml">~</span><span class="mr">~</span><span class="mp">~</span>',
    );
    expect(targetCell(post({ targets: { x: { status: "publishing" } } }), "x")).toContain("~");
    expect(targetCell(post({ targets: { x: { status: "failed" } } }), "x")).toBe(
      '<span class="mv">—</span><span class="ml">—</span><span class="mr">—</span><span class="mp">—</span>',
    );
  });

  it("distinguishes a collected zero from a metric that was never collected", () => {
    const cell = targetCell(post(published("x", { views: 0 })), "x");
    expect(cell).toContain('<span class="mv">0</span>');
    // likes were never sampled, so the cell must not claim zero likes.
    expect(cell).toContain('<span class="ml">—</span>');
  });

  it("links the views cell when the target has a public URL and leaves the rest plain", () => {
    const linked = targetCell(post({ ...published("x", { views: 7 }), targets: { x: { status: "published", external_id: "42" } } }), "x");
    expect(linked).toContain('<a class="metric-link" href="https://x.com/alexgetmancom/status/42"');
    expect(linked).toContain('rel="noopener noreferrer"');
    expect(linked.match(/<a /g)?.length).toBe(1);
  });

  it("labels media by kind and count, preferring the English gallery", () => {
    expect(formatMedia(post())).toBe("text");
    expect(formatMedia(post({ media_en_json: [{ type: "photo" }, { type: "photo" }] }))).toBe("pic (2)");
    expect(formatMedia(post({ media_en_json: [{ type: "video" }] }))).toBe("vid (1)");
    expect(formatMedia(post({ media_en_json: [{ media_type: "VIDEO" }, { type: "photo" }] }))).toBe("vid (2)");
    expect(formatMedia(post({ media_ru_json: [{ type: "photo" }], media_en_json: null }))).toBe("pic (1)");
  });
});

describe("renderPublicationColumns", () => {
  const viewed = (views: number, text: string): PipelinePost => ({
    post_id: views,
    text_en: text,
    ...published("x", { views }),
  });

  it("ranks the best posts by total views and caps the list at three", () => {
    const html = renderPublicationColumns([viewed(10, "ten"), viewed(300, "three hundred"), viewed(200, "two hundred"), viewed(5, "five")]);
    const ranks = [...html.matchAll(/best-post__title">([^<]+)</g)].map((match) => match[1]);
    expect(ranks).toEqual(["three hundred", "two hundred", "ten"]);
  });

  it("keeps the first five posts compact and exposes the rest on demand", () => {
    const html = renderPublicationColumns(Array.from({ length: 9 }, (_, index) => viewed(index, `post ${index}`)));
    expect(html.match(/<details class="post-detail">/g)?.length).toBe(5);
    expect(html.match(/post-detail--more/g)?.length).toBe(4);
    expect(html).toContain("Показать ещё <span>4</span>");
  });

  it("shows the empty state in both columns when there are no posts", () => {
    const html = renderPublicationColumns([]);
    expect(html.match(/За выбранный период публикаций нет/g)?.length).toBe(2);
    expect(html).not.toContain("<details");
  });

  it("escapes post text so a title cannot inject markup", () => {
    const html = renderPublicationColumns([viewed(10, '<img src=x onerror="alert(1)">')]);
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img");
  });

  it("omits the platform breakdown when nothing published", () => {
    const html = renderPublicationColumns([{ post_id: 1, text_en: "queued", targets: { x: { status: "queued" } } }]);
    expect(html).not.toContain("post-platforms");
  });

  it("falls back to the Russian text and then to a placeholder title", () => {
    expect(renderPublicationColumns([{ post_id: 1, text_ru: "Русский заголовок" }])).toContain("Русский заголовок");
    expect(renderPublicationColumns([{ post_id: 1 }])).toContain("Без текста");
  });

  it("renders a media preview only for an http or site-relative URL", () => {
    const withPreview = renderPublicationColumns([{ post_id: 1, media_en_json: [{ url: "/media/a.jpg" }] }]);
    expect(withPreview).toContain('<img src="/media/a.jpg"');

    const untrusted = renderPublicationColumns([{ post_id: 1, media_en_json: [{ url: "javascript:alert(1)" }] }]);
    expect(untrusted).not.toContain("javascript:");
    expect(untrusted).toContain("post-preview--empty");
  });
});
