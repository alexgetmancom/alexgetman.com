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
  // Telegram validates every webhook with its secret token in the endpoint.
  // Astro's browser-origin CSRF guard would otherwise reject Telegram's POST.
  security: { checkOrigin: false },
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
