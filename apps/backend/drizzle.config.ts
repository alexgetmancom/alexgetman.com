import path from "node:path";
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/db/schema/*.ts",
  casing: "snake_case",
  out: "./drizzle",
  dbCredentials: {
    url: path.join(process.env.DATA_DIR ?? "./data", "pipeline.db"),
  },
  strict: true,
  verbose: true,
});
