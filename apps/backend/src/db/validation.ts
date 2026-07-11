import { createInsertSchema } from "drizzle-zod";
import { publishJobs } from "./schema.js";

export const insertPublishJobSchema = createInsertSchema(publishJobs);
