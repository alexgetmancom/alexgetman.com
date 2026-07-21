import { describe, expect, it } from "bun:test";
import { categoryLabel, categorySlugFromBadge, getSmartCategory } from "./taxonomy";

describe("getSmartCategory", () => {
  it("mirrors getSmartBadge's label", () => {
    expect(getSmartCategory("OpenAI released a new model")).toBe("ИИ-Модели");
    expect(getSmartCategory("Someone leaked the roadmap")).toBe("Сливы");
    expect(getSmartCategory("Midjourney released a new image generator")).toBe("Нейросети");
    expect(getSmartCategory("Just a regular update")).toBe("Новости");
  });
});

describe("categorySlugFromBadge", () => {
  it("slugs a badge object by its class", () => {
    expect(categorySlugFromBadge({ class: "badge--ai" })).toBe("ai-models");
    expect(categorySlugFromBadge({ class: "badge--leaks" })).toBe("leaks");
    expect(categorySlugFromBadge({ class: "badge--neural" })).toBe("neural-networks");
    expect(categorySlugFromBadge({ class: "badge--news" })).toBe("news");
  });

  it("slugs a raw label string when there is no class", () => {
    expect(categorySlugFromBadge("Сливы")).toBe("leaks");
    expect(categorySlugFromBadge("ИИ-Модели")).toBe("ai-models");
    expect(categorySlugFromBadge("Нейросети")).toBe("neural-networks");
  });

  it("falls back to news for an unrecognized value", () => {
    expect(categorySlugFromBadge("something else")).toBe("news");
    expect(categorySlugFromBadge({})).toBe("news");
  });
});

describe("categoryLabel", () => {
  it("localizes a known slug", () => {
    expect(categoryLabel("ai-models", "en")).toBe("AI Models");
    expect(categoryLabel("ai-models", "ru")).toBe("ИИ-Модели");
    expect(categoryLabel("leaks", "ru")).toBe("Сливы");
  });

  it("falls back to the news label for an unknown slug", () => {
    expect(categoryLabel("nonsense", "en")).toBe("News");
    expect(categoryLabel("nonsense", "ru")).toBe("Новости");
  });
});
