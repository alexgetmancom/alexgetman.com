import type { StudioProfileRecord, StudioSettingsStore } from "../../src/application/ports.js";
import { type BackendConfig, type EnvConfig, loadConfig, withStudioProfile } from "../../src/foundation/config.js";
import { DEFAULT_STUDIO_PROFILE } from "../../src/studio.js";

/** The Studio profile a test runs against unless it says otherwise. It is held
 * in memory rather than in the test database: most tests never open one, and a
 * profile is the Studio's identity, not part of the case under test.
 *
 * The overrides are copied, never aliased: the exported profiles below are
 * shared module constants, and a test writing through one would change every
 * later test in the file. A test whose subject is a setting changing mid-run
 * builds its config over a real database instead, the way production does. */
function memoryProfileStore(overrides: Partial<StudioProfileRecord>): Pick<StudioSettingsStore, "profile" | "saveProfile"> {
  let row: StudioProfileRecord = { id: 1, ...DEFAULT_STUDIO_PROFILE, updatedAt: "1970-01-01T00:00:00.000Z", ...overrides };
  return {
    profile: () => row,
    saveProfile: (input) => {
      row = { ...row, ...input };
    },
  };
}

/** Env config plus a Studio profile, which is what production code receives.
 * Tests that need a different Studio pass the fields they care about. */
export function loadTestConfig(env: NodeJS.ProcessEnv = {}, profile: Partial<StudioProfileRecord> = {}): BackendConfig {
  return withStudioProfile(loadConfig(env) as EnvConfig, { studioSettings: memoryProfileStore(profile) as StudioSettingsStore });
}

/** Studio profile for tests whose subject is scheduling in a non-UTC zone. */
export const MSK_STUDIO_PROFILE: Partial<StudioProfileRecord> = { timezone: "Europe/Moscow", timezoneLabel: "MSK" };

/** Studio profile for tests about a Studio that serves a public website. */
export const SITE_STUDIO_PROFILE: Partial<StudioProfileRecord> = { siteEnabled: 1 };
