import type { BackendConfig } from "../foundation/config.js";
import { createChannelStoryClient } from "../foundation/external/telegram-session.js";

/**
 * Signs this Studio's Stories account in, once, and leaves the session where
 * delivery expects to find it.
 *
 * Telegram Stories are posted by a user, not a bot, so the credential is an
 * MTProto session rather than a token. Producing one meant running a script
 * from somewhere else and copying the result in, which is the step a
 * self-hosted install had no way past: `doctor` would name
 * TELEGRAM_CHANNEL_STORIES_SESSION as missing and nothing said how to make one.
 *
 * The session is a directory the client writes to, not a string to paste, so
 * this has to run where that directory lives — inside the container, against
 * the same path the setting already names.
 */
export type StoriesLoginPrompts = {
  phone: () => Promise<string>;
  code: () => Promise<string>;
  password: () => Promise<string>;
};

export type StoriesLoginResult = { signedIn: true; user: string; session: string };

export async function loginTelegramStories(
  config: BackendConfig,
  prompts: StoriesLoginPrompts,
  log: (message: string) => void = console.log,
  createClient = createChannelStoryClient,
): Promise<StoriesLoginResult> {
  if (!config.TELEGRAM_CHANNEL_STORIES_API_ID || !config.TELEGRAM_CHANNEL_STORIES_API_HASH)
    throw new Error(
      "Set TELEGRAM_CHANNEL_STORIES_API_ID and TELEGRAM_CHANNEL_STORIES_API_HASH first. Create them at https://my.telegram.org under API development tools.",
    );
  const session = config.TELEGRAM_CHANNEL_STORIES_SESSION;
  if (!session) throw new Error("Set TELEGRAM_CHANNEL_STORIES_SESSION to a writable path, for example /data/telegram_channel_stories.");

  const client = createClient(config);
  try {
    const user = await client.start({
      phone: prompts.phone,
      code: prompts.code,
      password: prompts.password,
      codeSentCallback: async () => log("Telegram sent a code to that account."),
      invalidCodeCallback: async (type) => log(`That ${type} was not accepted. Try again.`),
    });
    // The account itself, not the channel: a Story is posted by this user on
    // the channel's behalf, and signing in as the wrong one fails much later.
    return { signedIn: true, user: user.username ? `@${user.username}` : user.displayName, session };
  } finally {
    await client.destroy();
  }
}
