import node from "@astrojs/node";
import svelte from "@astrojs/svelte";
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
      external: ["@mtcute/bun", "@mtcute/wasm", "sharp"],
    },
  },
  // Svelte powers interactive islands (see apps/web/src/features/). Static
  // pages stay plain Astro.
  integrations: [svelte()],
  // The sitemap is served by the dynamic route apps/web/src/pages/sitemap.xml.ts,
  // which reads current slugs from the database. The @astrojs/sitemap integration
  // was removed: it snapshotted slugs at build time, so renamed posts left the
  // static sitemap full of URLs that 301 to their canonical form.
});
