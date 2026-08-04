export type PostWizardLocale = "ru" | "en";

export type PostWizardStep =
  | { type: "new_post" }
  | { type: "edit_sources" }
  | { type: "edit_text"; locale: PostWizardLocale }
  | { type: "replace_media"; locale: PostWizardLocale }
  | { type: "schedule_manual"; locale: PostWizardLocale }
  | { type: "schedule_confirm"; locale: PostWizardLocale; value: Date };

export type PostWizardStepValue =
  | "new_post"
  | "edit_sources"
  | "edit_ru"
  | "edit_en"
  | "replace_ru_media"
  | "replace_en_media"
  | `schedule_manual_${PostWizardLocale}`
  | `schedule_confirm_${PostWizardLocale}_${string}`;

export function parsePostWizardStep(value: string | null): PostWizardStep | null {
  if (value === "new_post") return { type: "new_post" };
  if (value === "edit_sources") return { type: "edit_sources" };
  if (value === "edit_ru") return { type: "edit_text", locale: "ru" };
  if (value === "edit_en") return { type: "edit_text", locale: "en" };
  if (value === "replace_ru_media") return { type: "replace_media", locale: "ru" };
  if (value === "replace_en_media") return { type: "replace_media", locale: "en" };

  const manualMatch = value?.match(/^schedule_manual_(ru|en)$/);
  if (manualMatch) return { type: "schedule_manual", locale: manualMatch[1] as PostWizardLocale };

  const confirmMatch = value?.match(/^schedule_confirm_(ru|en)_(.+)$/);
  if (!confirmMatch) return null;
  const date = new Date(confirmMatch[2] ?? "");
  if (Number.isNaN(date.getTime())) return null;
  return { type: "schedule_confirm", locale: confirmMatch[1] as PostWizardLocale, value: date };
}

export function encodePostWizardStep(step: PostWizardStep): PostWizardStepValue {
  switch (step.type) {
    case "new_post":
      return "new_post";
    case "edit_sources":
      return "edit_sources";
    case "edit_text":
      return `edit_${step.locale}`;
    case "replace_media":
      return `replace_${step.locale}_media`;
    case "schedule_manual":
      return `schedule_manual_${step.locale}`;
    case "schedule_confirm":
      return `schedule_confirm_${step.locale}_${step.value.toISOString()}`;
  }
}

export function isPostInputStep(step: PostWizardStep | null): boolean {
  return step?.type === "edit_sources" || step?.type === "edit_text" || step?.type === "replace_media" || step?.type === "schedule_manual";
}
