export type ParsedCommand =
  | { kind: "simple"; name: string }
  | { kind: "kv"; name: string; value: string | number | boolean }
  | { kind: "complex"; name: string; value: unknown };

export function parseStep(step: import("../types.js").FlowStep): ParsedCommand {
  if (typeof step === "string") {
    return { kind: "simple", name: step };
  }
  const keys = Object.keys(step);
  if (keys.length !== 1) {
    throw new Error(`Step must have exactly one command key, got: ${keys.join(", ")}`);
  }
  const name = keys[0]!;
  const value = step[name];
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return { kind: "kv", name, value };
  }
  return { kind: "complex", name, value };
}

export const SIMPLE_COMMANDS = new Set([
  "launchApp",
  "stopApp",
  "clearState"
]);
