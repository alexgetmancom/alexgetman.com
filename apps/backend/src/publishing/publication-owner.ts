import { parsePublicationRef } from "../application/publication-ref.js";
import type { BackendDb } from "../db/client.js";
import { refreshArticleStatus } from "./article-status.js";
import { refreshPublicationStatus } from "./publication-status.js";

/** Which kind of publication keeps its status where. The queue settles a job
 * and asks for the owner to be refreshed; it never learns what kinds exist,
 * because a queue that knows is a queue that grows one branch per kind and
 * eventually forgets to grow one. */
const OWNERS: Record<string, (backendDb: BackendDb, id: number) => void> = {
  post: refreshPublicationStatus,
  article: refreshArticleStatus,
};

/** Refreshes the publication a settled job belongs to. A key naming a kind
 * with no owner -- video settles through its own workflow -- is not an error:
 * there is simply nothing here to update. */
export function refreshPublicationOwner(backendDb: BackendDb, publicationKey: string): void {
  const ref = parsePublicationRef(publicationKey);
  if (!ref) return;
  OWNERS[ref.kind]?.(backendDb, ref.id);
}
