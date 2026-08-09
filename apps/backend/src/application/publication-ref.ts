type PublicationRefKind = "draft" | "post" | "video";
type PublicationRef = `publication:${PublicationRefKind}:${number}`;

/** Serializes every Studio publication identity into the one event-journal format. */
export function publicationRef(kind: PublicationRefKind, id: number): PublicationRef {
  return `publication:${kind}:${id}` as PublicationRef;
}

export function parsePublicationRef(value: string | null | undefined): { kind: PublicationRefKind; id: number } | null {
  const match = value?.match(/^publication:(draft|post|video):(\d+)$/);
  if (!match) return null;
  const id = Number(match[2]);
  return Number.isSafeInteger(id) ? { kind: match[1] as PublicationRefKind, id } : null;
}
