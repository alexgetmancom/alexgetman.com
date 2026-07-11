export function parseJsonValue(value: unknown): unknown {
  if (typeof value !== "string") return value ?? null;
  if (!value) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

export function jsonObject(value: unknown): Record<string, unknown> {
  const parsed = parseJsonValue(value);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
}

export function jsonArray(value: unknown): unknown[] {
  const parsed = parseJsonValue(value);
  return Array.isArray(parsed) ? parsed : [];
}

export function jsonRecordArray(value: unknown): Record<string, unknown>[] {
  return jsonArray(value).filter(
    (item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item),
  );
}
