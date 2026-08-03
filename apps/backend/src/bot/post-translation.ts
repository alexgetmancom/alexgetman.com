import { translateToEnglish } from "../content/translation.js";
import type { BackendConfig } from "../foundation/config.js";
import { log } from "../foundation/logger.js";

export async function translatePostText(text: string, config: BackendConfig): Promise<string> {
  try {
    return await translateToEnglish(text, config);
  } catch (error) {
    log("warn", "draft translation failed", { error: String(error) });
    return text;
  }
}
