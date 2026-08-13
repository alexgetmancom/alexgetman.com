import { join } from "node:path";

/** Studio config for tests whose subject is scheduling in a non-UTC zone.
 * Passing this keeps them independent of the product's default studio.yaml,
 * which is UTC and belongs to a fresh install rather than to any test. */
export const MSK_STUDIO_CONFIG = join(import.meta.dir, "studio-msk.yaml");
