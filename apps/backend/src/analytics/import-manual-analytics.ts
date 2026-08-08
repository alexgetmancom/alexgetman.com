import type { BackendDb } from "../db/client.js";
import { importXAnalyticsCsv, type XCsvImportResult } from "./import-x-csv.js";
import { recordProfileSnapshot } from "./snapshots/creator-store.js";

type ManualAnalyticsInput = {
  sampledAt: string;
  xFile?: string;
  threadsRuFollowers?: number;
  threadsEnFollowers?: number;
};

type ManualProfileResult = {
  platform: "threads_ru" | "threads_en";
  account: "alexgetmanru" | "alexgetmanco";
  followersCount: number;
};

type ManualAnalyticsImportResult = {
  sampledAt: string;
  x: XCsvImportResult | null;
  profiles: ManualProfileResult[];
};

/** Records one operator-supplied weekly observation without coupling the flow
 * to Telegram or requiring ad-hoc SQL against production. */
export function importManualAnalytics(backendDb: BackendDb, input: ManualAnalyticsInput): ManualAnalyticsImportResult {
  const sampledAt = new Date(input.sampledAt);
  if (Number.isNaN(sampledAt.getTime())) throw new Error("--sampled-at must be an ISO timestamp");
  const profiles = [
    profileInput("threads_ru", "alexgetmanru", input.threadsRuFollowers),
    profileInput("threads_en", "alexgetmanco", input.threadsEnFollowers),
  ].filter((profile): profile is ManualProfileResult => profile != null);
  if (!input.xFile && profiles.length === 0) throw new Error("provide --x-file, --threads-ru-followers, or --threads-en-followers");

  const x = input.xFile ? importXAnalyticsCsv(backendDb, input.xFile, sampledAt.toISOString()) : null;
  for (const profile of profiles)
    recordProfileSnapshot(backendDb, {
      platform: profile.platform,
      account: profile.account,
      metrics: { name: profile.account, followersCount: profile.followersCount, manual: true },
      source: "manual_cli",
      sampledAt,
    });
  return { sampledAt: sampledAt.toISOString(), x, profiles };
}

function profileInput(
  platform: ManualProfileResult["platform"],
  account: ManualProfileResult["account"],
  value: number | undefined,
): ManualProfileResult | null {
  if (value == null) return null;
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error(`--${platform.replaceAll("_", "-")}-followers must be a non-negative integer`);
  return { platform, account, followersCount: value };
}
