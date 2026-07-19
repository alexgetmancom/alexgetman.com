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
  // Command Center validates its own canonical Origin. Astro's generic check
  // sees the internal reverse-proxy host and rejects a legitimate login form.
  security: { checkOrigin: false },
  vite: {
    ssr: {
      external: ["@mtcute/bun", "@mtcute/wasm"],
    },
  },
  integrations: [
    sitemap({
      lastmod: new Date(),
      // Only canonical content URLs belong in the sitemap. The application also
      // exposes compatibility and utility routes, many of which deliberately
      // carry noindex; advertising those URLs to Google creates needless
      // canonical and video-indexing noise.
      filter: (page) => /^(?:\/$|\/ru\/$|\/(?:ru\/)?\d+\/[^/]+\/$)/.test(new URL(page).pathname),
    }),
  ],
});
