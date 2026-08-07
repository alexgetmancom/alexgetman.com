import { describe, expect, it } from "bun:test";
import { storyUi } from "./i18n";

describe("story player locales", () => {
  it("does not expose English feed labels in Russian", () => {
    const ui = storyUi("ru");
    expect(ui.feedLatest).toBe("Последние");
    expect(ui.feedDeep).toBe("Глубокие");
    expect(ui.feedWatched).toBe("Просмотренные");
  });
});
