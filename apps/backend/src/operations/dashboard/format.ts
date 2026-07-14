export function formatDayHeaderRu(date: Date): string {
  const ruMonths = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
  return `${date.getUTCDate()} ${ruMonths[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

export function getMskDateString(dateStr: string | null | undefined): string {
  const date = new Date(dateStr ?? "");
  if (Number.isNaN(date.getTime())) return new Date().toISOString().slice(0, 10);
  const msk = new Date(date.getTime() + 3 * 3_600_000);
  return msk.toISOString().slice(0, 10);
}

export function formatTimeMsk(dateStr: string | null | undefined): string {
  const date = new Date(dateStr ?? "");
  if (Number.isNaN(date.getTime())) return "--:--";
  const msk = new Date(date.getTime() + 3 * 3_600_000);
  const hours = String(msk.getUTCHours()).padStart(2, "0");
  const minutes = String(msk.getUTCMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
}

export function formatMetricValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  const num = Number(value);
  if (Number.isNaN(num)) return "";
  if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(1)}m`.replace(".0m", "m");
  if (num >= 1_000) return `${(num / 1_000).toFixed(1)}k`.replace(".0k", "k");
  return String(num);
}

export function getWeekBounds(weekOffset: number): [Date, Date] {
  const nowMsk = new Date(Date.now() + 3 * 3_600_000);
  const weekday = (nowMsk.getUTCDay() + 6) % 7;
  const start = Date.UTC(nowMsk.getUTCFullYear(), nowMsk.getUTCMonth(), nowMsk.getUTCDate() - weekday - weekOffset * 7, -3, 0, 0);
  return [new Date(start + 3 * 3_600_000), new Date(start + 7 * 86_400_000 - 1 + 3 * 3_600_000)];
}

export function shortPipelineText(value: string | null | undefined, wordLimit = 7): string {
  if (!value) return "";
  const words = value.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  if (words.length <= wordLimit) return words.join(" ");
  return `${words.slice(0, wordLimit).join(" ")}...`;
}
