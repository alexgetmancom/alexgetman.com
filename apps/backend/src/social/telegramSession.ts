import fs from "node:fs";
import { Database } from "bun:sqlite";
import { sessions } from "telegram";

type TelethonSessionRow = {
  dc_id: number;
  server_address: string;
  port: number;
  auth_key: Buffer | Uint8Array;
};

export function loadChannelStorySession(value: string): sessions.StringSession {
  try {
    return new sessions.StringSession(value);
  } catch {
    // Telethon stores its session in SQLite and appends .session to a basename.
  }

  const filePath = [value, `${value}.session`].find((candidate) => fs.existsSync(candidate));
  if (!filePath) throw new Error("telegram_channel_story_session_not_found");

  const sqlite = new Database(filePath, { readonly: true, strict: true });
  try {
    const row = sqlite.prepare("SELECT dc_id, server_address, port, auth_key FROM sessions LIMIT 1").get() as TelethonSessionRow | undefined;
    if (!row || !(row.auth_key instanceof Uint8Array) || row.auth_key.byteLength !== 256) {
      throw new Error("telegram_channel_story_session_invalid");
    }
    return new sessions.StringSession(encodeStringSession({ ...row, auth_key: Buffer.from(row.auth_key) }));
  } finally {
    sqlite.close();
  }
}

function encodeStringSession(row: TelethonSessionRow & { auth_key: Buffer }): string {
  const address = Buffer.from(row.server_address, "utf8");
  const addressLength = Buffer.alloc(2);
  addressLength.writeInt16BE(address.length);
  const port = Buffer.alloc(2);
  port.writeInt16BE(row.port);
  return `1${Buffer.concat([Buffer.from([row.dc_id]), addressLength, address, port, row.auth_key]).toString("base64")}`;
}
