export function getMskDateString(dateStr: string | null | undefined): string {
  const date = new Date(dateStr ?? "");
  if (Number.isNaN(date.getTime())) return new Date().toISOString().slice(0, 10);
  const msk = new Date(date.getTime() + 3 * 3_600_000);
  return msk.toISOString().slice(0, 10);
}

export function formatMetricValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  const num = Number(value);
  if (Number.isNaN(num)) return "";
  if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(1)}m`.replace(".0m", "m");
  if (num >= 1_000) return `${(num / 1_000).toFixed(1)}k`.replace(".0k", "k");
  return String(num);
}

// Week bounds live in foundation/time.ts (`zonedWeekBounds`): it honours the
// configured IANA zone instead of a hardcoded +3h and is covered by tests. The
// local copy here was unused and returned zone-shifted Date objects that were
// only correct when read back through getUTC* — a trap for the next caller.

export function shortPipelineText(value: string | null | undefined, wordLimit = 7): string {
  if (!value) return "";
  const words = value.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  if (words.length <= wordLimit) return words.join(" ");
  return `${words.slice(0, wordLimit).join(" ")}...`;
}
