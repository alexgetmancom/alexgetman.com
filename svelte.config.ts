/* Нужен для svelte-check и TypeScript внутри .svelte-компонентов.
 * @astrojs/svelte работает и без него, но svelte-check требует препроцессор. */
import { vitePreprocess } from "@astrojs/svelte";

export default {
  preprocess: vitePreprocess(),
};
