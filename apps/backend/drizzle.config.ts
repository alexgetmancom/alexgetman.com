import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/db/schema/*.ts",
  casing: "snake_case",
  out: "./drizzle",
  dbCredentials: {
    url: process.env.PIPELINE_DB ?? "./data/pipeline.db",
  },
  strict: true,
  verbose: true,
});
