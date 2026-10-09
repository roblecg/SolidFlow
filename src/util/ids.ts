import { randomBytes } from "node:crypto";

export function newRunId(): string {
  const t = Date.now().toString(36);
  const r = randomBytes(4).toString("hex");
  return `${t}-${r}`;
}

export function interpolateEnv(
  value: string,
  env: Record<string, string>
): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, key: string) => {
    if (env[key] === undefined) {
      throw new Error(`Missing env variable: ${key}`);
    }
    return env[key];
  });
}
