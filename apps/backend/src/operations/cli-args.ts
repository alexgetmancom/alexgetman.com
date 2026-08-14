import { inputJsonSchema, operationDef } from "./registry.js";

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
    // Every argument belongs to an option. A bare word is a value written
    // without the option it belongs to, and dropping it silently runs a
    // different command: `recent 10` reported five posts and said nothing.
    if (!token?.startsWith("--"))
      throw new Error(`${command}: unexpected argument ${JSON.stringify(token ?? "")}; options are --name value`);
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
 * everything else is the last value given. Coercion belongs to the schema, and
 * so does rejecting an option no field answers to — every option spelled on the
 * line reaches the input, and `runOperation` names the ones it does not know. */
export function operationInput(name: string, args: Arguments): Record<string, unknown> {
  const def = operationDef(name);
  if (!def) throw new Error(`unknown command: ${name}`);
  const properties = (inputJsonSchema(def.schema).properties ?? {}) as Record<string, { type?: string }>;
  const input: Record<string, unknown> = {};
  for (const option of args.seen) {
    if (GLOBAL_OPTIONS.includes(option)) continue;
    const field = option.replace(/-/g, "_");
    const value = args.values.get(option);
    if (properties[field]?.type === "boolean") {
      // `--apply true` used to park "true" in `values`, where a boolean field
      // never looks: the mutation stayed unarmed and the run still reported ok.
      if (value !== undefined) throw new Error(`${name}: --${option} is a flag; write it alone, not --${option} ${value}`);
      input[field] = args.flags.has(option);
      continue;
    }
    if (value === undefined && properties[field]) throw new Error(`${name}: --${option} needs a value`);
    input[field] = value === undefined ? true : value;
  }
  return input;
}
