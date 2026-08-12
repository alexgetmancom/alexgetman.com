import { Database } from "bun:sqlite";
import { expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

it("removes the retired dashboard usage key without touching current history", () => {
  const db = new Database(":memory:", { strict: true });
  try {
    db.exec("CREATE TABLE runtime_usage (feature_key text NOT NULL)");
    db.exec("INSERT INTO runtime_usage VALUES ('command_center.dashboard.view'), ('command_center.dashboard.render')");
    db.exec(readFileSync(path.join(import.meta.dir, "../drizzle/0014_remove_retired_usage_key.sql"), "utf8"));

    expect(db.query("SELECT feature_key FROM runtime_usage").all()).toEqual([{ feature_key: "command_center.dashboard.render" }]);
  } finally {
    db.close();
  }
});
