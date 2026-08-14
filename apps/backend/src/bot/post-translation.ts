import { translateToEnglish } from "../content/translation.js";
import type { BackendConfig } from "../foundation/config.js";
import { log } from "../foundation/logger.js";

/** The English text, or nothing when the translator could not produce one.
 *
 * It used to answer with the Russian text it was given, which is the one answer
 * that cannot be told apart from a real translation: the draft looked finished,
 * and the English channels published Russian. A draft with no English text says
 * so, and preflight refuses to publish that locale until it has one. */
export async function translatePostText(text: string, config: BackendConfig): Promise<string | undefined> {
  try {
    return await translateToEnglish(text, config);
  } catch (error) {
    log("warn", "draft translation failed", { error: String(error) });
    return undefined;
  }
}
