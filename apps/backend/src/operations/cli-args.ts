import { operationDef, operationJsonSchema, optionFlag } from "./registry.js";

export type Arguments = {
  command: string;
  values: Map<string, string>;
  flags: Set<string>;
  /** Every option spelled on the line, so an undefined one can be rejected. */
  seen: Set<string>;
};

/** Options the dispatcher owns rather than any operation's schema. */
const GLOBAL_OPTIONS = ["db", "json"];

export function parseArguments(argv: string[]): Arguments {
  const command = argv[0] ?? "help";
  const values = new Map<string, string>();
  const flags = new Set<string>();
  const seen = new Set<string>();
  const record = (name: string, value: string): void => {
    values.set(name, value);
  };
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token?.startsWith("--")) continue;
    const equals = token.indexOf("=");
    if (equals > 2) {
      const name = token.slice(2, equals);
      seen.add(name);
      const value = token.slice(equals + 1);
      // A boolean field reads from `flags` alone, so `--apply=true` parsed as a
      // value would leave the mutation unarmed and still report `ok`.
      if (["true", "false"].includes(value.toLowerCase())) {
        // The last spelling wins, the way it does for a value: `--apply=true
        // --apply=false` left the mutation armed when `false` only failed to
        // add the flag its predecessor had already set.
        if (value.toLowerCase() === "true") flags.add(name);
        else flags.delete(name);
      } else record(name, value);
      continue;
    }
    const name = token.slice(2);
    seen.add(name);
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      record(name, next);
      index += 1;
    } else flags.add(name);
  }
  return { command, values, flags, seen };
}

/** Argv against the operation's own schema: a boolean field is a bare flag and
 * everything else is the last value given. Coercion belongs to the schema. */
export function operationInput(name: string, args: Arguments): Record<string, unknown> {
  const properties = (operationJsonSchema(operationDef(name) as never).properties ?? {}) as Record<string, { type?: string }>;
  assertKnownOptions(name, args, properties);
  const input: Record<string, unknown> = {};
  for (const [field, property] of Object.entries(properties)) {
    const flag = optionFlag(field);
    if (property.type === "boolean") {
      if (args.flags.has(flag)) input[field] = true;
      continue;
    }
    const value = args.values.get(flag);
    if (value !== undefined) input[field] = value;
  }
  return input;
}

/** An option the schema does not define is a typo, and accepting it silently
 * changes what ran: `--ref` for `--refs` widens a scoped backfill to every
 * target the default covers. */
function assertKnownOptions(name: string, args: Arguments, properties: Record<string, unknown>): void {
  const known = [...Object.keys(properties).map(optionFlag), ...GLOBAL_OPTIONS];
  const unknown = [...args.seen].filter((option) => !known.includes(option));
  if (!unknown.length) return;
  const offenders = unknown.map((option) => `--${option}`).join(", ");
  throw new Error(`${name}: unknown option${unknown.length > 1 ? "s" : ""} ${offenders}; accepts ${known.map((o) => `--${o}`).join(", ")}`);
}
