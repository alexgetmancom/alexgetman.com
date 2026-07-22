import { describe, expect, it, mock } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { openBackendDb } from "../src/db/client.js";
import { credentialChecks, postEvents } from "../src/db/schema.js";
import { loadConfig } from "../src/foundation/config.js";
import { checkTokenHealth } from "../src/observability/token-health.js";

function tempDb() {
  const dir = mkdtempSync(join(tmpdir(), "alexgetman-token-health-"));
  return openBackendDb(join(dir, "pipeline.db"), 5000);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe("token health probes", () => {
  it("warns when a Graph API token is close to expiring", async () => {
    const backendDb = tempDb();
    try {
      const soon = new Date(Date.now() + 24 * 60 * 60 * 1000);
      const fetchMock = mock(async (url: string | URL | Request) => {
        const href = String(url);
        if (href.includes("debug_token")) return jsonResponse({ data: { expires_at: Math.floor(soon.getTime() / 1000) } });
        return jsonResponse({ id: "123" });
      });
      const config = loadConfig({ INSTAGRAM_ACCESS_TOKEN: "EAAtoken", INSTAGRAM_USER_ID: "123" });

      await checkTokenHealth(config, backendDb, fetchMock as unknown as typeof fetch);

      const row = backendDb.db.select().from(credentialChecks).where(eq(credentialChecks.target, "instagram_reels")).get();
      expect(row?.expiresAt).toBe(new Date(Math.floor(soon.getTime() / 1000) * 1000).toISOString());

      const event = backendDb.db.select().from(postEvents).where(eq(postEvents.eventType, "credential.token_expiring_soon")).get();
      expect(event).not.toBeUndefined();
      expect(event?.target).toBe("instagram_reels");
    } finally {
      backendDb.close();
    }
  });
});
