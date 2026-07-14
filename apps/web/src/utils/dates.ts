export function formatDate(value: string, locale = "en-GB"): string {
  if (!value) return "";
  try {
    return new Intl.DateTimeFormat(locale, {
      timeZone: "Europe/Moscow",
      day: "2-digit",
      month: locale === "ru-RU" ? "2-digit" : "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    })
      .format(new Date(value))
      .replace(",", "");
  } catch {
    return value;
  }
}

export function formatRelativeTime(value: string, locale = "en"): string {
  try {
    const diffMs = Date.now() - new Date(value).getTime();
    const absMs = Math.abs(diffMs);
    const minute = 60_000;
    const hour = 60 * minute;
    const day = 24 * hour;
    const rtf = new Intl.RelativeTimeFormat(locale === "ru" ? "ru" : "en", { numeric: "auto" });
    if (absMs < hour) return rtf.format(Math.round(-diffMs / minute), "minute");
    if (absMs < day) return rtf.format(Math.round(-diffMs / hour), "hour");
    return rtf.format(Math.round(-diffMs / day), "day");
  } catch {
    return "";
  }
}
