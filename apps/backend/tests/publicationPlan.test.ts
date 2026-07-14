import { describe, expect, it } from "bun:test";
import { createPublicationPlan } from "../src/publishing/publication-plan.js";

describe("PublicationPlan", () => {
  it("decides localized content and target schedule before persistence", () => {
    const plan = createPublicationPlan(
      {
        channel_message_id: 42,
        text_ru: "Русский заголовок\nТекст",
        text_en_machine: "English title\nText",
        text_en_approved: null,
        targets_json: JSON.stringify({ telegram: true, threads_en: true, site_ru: true, site_en: true }),
        media_ru_json: JSON.stringify([{ file_id: "ru-image" }]),
        media_en_json: JSON.stringify([{ file_id: "en-image" }]),
        text_ru_entities_json: "[]",
        text_en_entities_json: "[]",
      } as never,
      9,
      99,
      { mode: "scheduled", ruAt: "2026-07-15T10:00:00.000Z", enAt: "2026-07-15T12:00:00.000Z" },
      "2026-07-14T10:00:00.000Z",
    );

    expect(plan).toMatchObject({ draftId: 9, postId: 99, postKey: "post:99", messageId: 42, mode: "scheduled" });
    expect(plan.payload).toMatchObject({
      text_ru: "Русский заголовок\nТекст",
      text_en: "English title\nText",
      publish_at_en: "2026-07-15T12:00:00.000Z",
    });
    expect(plan.locales).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ locale: "ru", siteEnabled: 1 }),
        expect.objectContaining({ locale: "en", siteEnabled: 1 }),
      ]),
    );
  });
});
