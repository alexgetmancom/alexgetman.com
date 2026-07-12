import node from "@astrojs/node";
import sitemap from "@astrojs/sitemap";
import { defineConfig } from "astro/config";

// https://astro.build/config
export default defineConfig({
  site: "https://alexgetman.com",
  srcDir: "./apps/web/src",
  publicDir: "./apps/web/public",
  outDir: "./dist",
  output: "server",
  adapter: node({ mode: "middleware" }),
  security: { checkOrigin: true },
  vite: {
    ssr: {
      external: ["@mtcute/bun", "@mtcute/wasm"],
    },
  },
  integrations: [
    sitemap({
      lastmod: new Date(),
      filter: (page) => !["/posts/", "/en/posts/", "/ru/posts/"].some((legacyPrefix) => new URL(page).pathname.startsWith(legacyPrefix)),
    }),
  ],
});
