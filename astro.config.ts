import sitemap from "@astrojs/sitemap";
import { defineConfig } from "astro/config";

// https://astro.build/config
export default defineConfig({
  site: "https://alexgetman.com",
  srcDir: "./apps/web/src",
  publicDir: "./apps/web/public",
  outDir: "./dist",
  integrations: [
    sitemap({
      lastmod: new Date(),
      filter: (page) => !["/posts/", "/en/posts/", "/ru/posts/"].some((legacyPrefix) => new URL(page).pathname.startsWith(legacyPrefix)),
    }),
  ],
});
